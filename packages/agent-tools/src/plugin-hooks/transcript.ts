import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  PiHistoryChangedHookInput,
  PiOnHistoryChangedHook,
} from '@mavis/agent-core/pi-turn-runner';

const TRANSCRIPT_DIRECTORY_MODE = 0o700;
const TRANSCRIPT_FILE_MODE = 0o600;
const TRANSCRIPT_FILE_SUFFIXES = ['.compatible.jsonl', '.codex.jsonl'] as const;
const DEFAULT_TRANSCRIPT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_TRANSCRIPT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TRANSCRIPT_MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAINTENANCE_STAT_BATCH_SIZE = 256;
const activeTranscriptPathOwners = new Map<string, Set<symbol>>();
const transcriptPathLeaseFinalizer = new FinalizationRegistry<{
  readonly paths: readonly string[];
  readonly owner: symbol;
}>(({ paths, owner }) => releaseTranscriptPaths(paths, owner));

export interface PluginHookTranscriptStorageOptions {
  readonly directory?: string;
  readonly maxAgeMs?: number;
  readonly maxFileBytes?: number;
  readonly maxDirectoryBytes?: number;
  readonly nowMs?: () => number;
}

/** Maintains separate Compatible conversation and Codex rollout projections. */
export class PluginHookTranscript {
  readonly path: string;
  readonly codexPath: string;
  private messageOffset = 0;
  private lastCompatibleUuid: string | null = null;
  private operation = Promise.resolve();
  private cleaned = false;

  private constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
    private readonly directory: string,
    private readonly maxAgeMs: number,
    private readonly maxFileBytes: number,
    private readonly maxDirectoryBytes: number,
    private readonly nowMs: () => number,
    private readonly pathOwner: symbol,
    path: string,
    codexPath: string,
  ) {
    this.path = path;
    this.codexPath = codexPath;
  }

  static async create(input: {
    readonly sessionId: string;
    readonly messages: readonly AgentMessage[];
    readonly cwd?: string;
    readonly storage?: PluginHookTranscriptStorageOptions;
  }): Promise<PluginHookTranscript> {
    const directory = input.storage?.directory ?? pluginHookTranscriptDirectory();
    const nowMs = input.storage?.nowMs ?? Date.now;
    const maxAgeMs = positiveLimit(input.storage?.maxAgeMs, DEFAULT_TRANSCRIPT_MAX_AGE_MS);
    const maxFileBytes = positiveLimit(
      input.storage?.maxFileBytes,
      DEFAULT_TRANSCRIPT_MAX_FILE_BYTES,
    );
    const maxDirectoryBytes = Math.max(
      maxFileBytes * 2,
      positiveLimit(input.storage?.maxDirectoryBytes, DEFAULT_TRANSCRIPT_MAX_DIRECTORY_BYTES),
    );
    await mkdir(directory, { recursive: true, mode: TRANSCRIPT_DIRECTORY_MODE });
    const paths = pluginHookTranscriptPaths(input.sessionId, directory);
    const ownedPaths = [paths.path, paths.codexPath] as const;
    const pathOwner = Symbol(input.sessionId);
    retainTranscriptPaths(ownedPaths, pathOwner);
    try {
      await maintainTranscriptDirectory(directory, {
        nowMs: nowMs(),
        maxAgeMs,
        maxDirectoryBytes,
        protectedPaths: new Set(ownedPaths),
      });
    } catch (error) {
      releaseTranscriptPaths(ownedPaths, pathOwner);
      throw error;
    }
    const transcript = new PluginHookTranscript(
      input.sessionId,
      input.cwd ?? process.cwd(),
      directory,
      maxAgeMs,
      maxFileBytes,
      maxDirectoryBytes,
      nowMs,
      pathOwner,
      paths.path,
      paths.codexPath,
    );
    transcriptPathLeaseFinalizer.register(
      transcript,
      { paths: ownedPaths, owner: pathOwner },
      transcript,
    );
    try {
      await transcript.replace(input.messages);
      return transcript;
    } catch (error) {
      if (transcript.releasePathLease()) {
        await Promise.all([
          rm(paths.path, { force: true }).catch(() => undefined),
          rm(paths.codexPath, { force: true }).catch(() => undefined),
        ]);
      }
      throw error;
    }
  }

  readonly onHistoryChanged: PiOnHistoryChangedHook = async (change) => {
    await this.apply(change);
  };

  async apply(change: PiHistoryChangedHookInput): Promise<void> {
    await this.enqueue(async () => {
      if (this.cleaned) return;
      if (change.reason === 'replaceMessages') {
        await this.replaceNow(change.messages);
        return;
      }
      if (change.messages.length === 0) return;
      const start = this.messageOffset;
      const compatible = serializeCompatibleMessages(
        this.sessionId,
        change.messages,
        start,
        this.lastCompatibleUuid,
      );
      await Promise.all([
        appendBoundedJsonl(this.path, compatible.rows, this.maxFileBytes, false),
        appendCodexBoundedJsonl(
          this.codexPath,
          codexSessionMeta(this.sessionId, this.cwd, change.messages),
          change.messages.flatMap(codexRolloutRows),
          this.maxFileBytes,
        ),
      ]);
      this.messageOffset += change.messages.length;
      this.lastCompatibleUuid = compatible.lastUuid;
      await this.maintainDirectory();
    });
  }

  /** Deletes both vendor projections. Safe to call repeatedly or after a failed create/apply. */
  async cleanup(): Promise<void> {
    await this.enqueue(async () => {
      if (this.cleaned) return;
      this.cleaned = true;
      if (this.releasePathLease()) {
        await Promise.all([
          rm(this.path, { force: true }).catch(() => undefined),
          rm(this.codexPath, { force: true }).catch(() => undefined),
        ]);
      }
    });
  }

  private async replace(messages: readonly AgentMessage[]): Promise<void> {
    await this.enqueue(() => this.replaceNow(messages));
  }

  private async replaceNow(messages: readonly AgentMessage[]): Promise<void> {
    if (this.cleaned) return;
    const compatible = serializeCompatibleMessages(this.sessionId, messages, 0, null);
    await Promise.all([
      writeJsonl(this.path, compatible.rows, this.maxFileBytes, false),
      writeJsonl(
        this.codexPath,
        [
          codexSessionMeta(this.sessionId, this.cwd, messages),
          ...messages.flatMap(codexRolloutRows),
        ],
        this.maxFileBytes,
        true,
      ),
    ]);
    this.messageOffset = messages.length;
    this.lastCompatibleUuid = compatible.lastUuid;
    await this.maintainDirectory();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operation.then(operation, operation);
    this.operation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private maintainDirectory(): Promise<void> {
    return maintainTranscriptDirectory(this.directory, {
      nowMs: this.nowMs(),
      maxAgeMs: this.maxAgeMs,
      maxDirectoryBytes: this.maxDirectoryBytes,
      protectedPaths: new Set([this.path, this.codexPath]),
    });
  }

  private releasePathLease(): boolean {
    transcriptPathLeaseFinalizer.unregister(this);
    return releaseTranscriptPaths([this.path, this.codexPath], this.pathOwner);
  }
}

export function pluginHookTranscriptDirectory(): string {
  return join(tmpdir(), 'minimax-plugin-hooks', 'transcripts');
}

export function pluginHookTranscriptPath(
  sessionId: string,
  directory = pluginHookTranscriptDirectory(),
): string {
  return pluginHookTranscriptPaths(sessionId, directory).path;
}

export function pluginHookCodexTranscriptPath(
  sessionId: string,
  directory = pluginHookTranscriptDirectory(),
): string {
  return pluginHookTranscriptPaths(sessionId, directory).codexPath;
}

function pluginHookTranscriptPaths(
  sessionId: string,
  directory: string,
): { readonly path: string; readonly codexPath: string } {
  const key = sessionKey(sessionId);
  return {
    path: join(directory, `${key}.compatible.jsonl`),
    codexPath: join(directory, `${key}.codex.jsonl`),
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function serializeCompatibleMessages(
  sessionId: string,
  messages: readonly AgentMessage[],
  startIndex: number,
  initialParentUuid: string | null,
): { readonly rows: readonly unknown[]; readonly lastUuid: string | null } {
  let parentUuid = initialParentUuid;
  const rows = messages.map((message, index) => {
    const row = compatibleTranscriptRow(sessionId, message, startIndex + index, parentUuid);
    parentUuid = row.uuid;
    return row;
  });
  return {
    rows,
    lastUuid: parentUuid,
  };
}

function compatibleTranscriptRow(
  sessionId: string,
  message: AgentMessage,
  index: number,
  parentUuid: string | null,
) {
  const common = {
    uuid: stableMessageId(sessionId, message, index),
    parentUuid,
    sessionId,
    timestamp: new Date(message.timestamp).toISOString(),
  };
  if (message.role === 'assistant') {
    return {
      ...common,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: message.content.map((part) =>
          part.type === 'toolCall'
            ? { type: 'tool_use', id: part.id, name: part.name, input: part.arguments }
            : normalizedContentPart(part),
        ),
      },
    };
  }
  if (message.role === 'toolResult') {
    return {
      ...common,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId,
            content: normalizedContentBlocks(message.content),
            is_error: message.isError,
          },
        ],
      },
      toolUseResult: normalizedContentBlocks(message.content),
    };
  }
  if (message.role === 'user') {
    return {
      ...common,
      type: 'user',
      message: { role: 'user', content: normalizedContentBlocks(message.content) },
    };
  }
  const fallback = message as unknown as Readonly<Record<string, unknown>>;
  return {
    ...common,
    type: 'system',
    subtype: typeof fallback.customType === 'string' ? fallback.customType : message.role,
    message: {
      role: 'user',
      content: normalizedContentBlocks(fallback.content ?? JSON.stringify(fallback)),
    },
  };
}

function stableMessageId(sessionId: string, message: AgentMessage, index: number): string {
  return `projection-${index}-${createHash('sha256')
    .update(sessionId)
    .update(message.role)
    .update(String(message.timestamp))
    .update(message.role === 'toolResult' ? message.toolCallId : '')
    .digest('hex')
    .slice(0, 16)}`;
}

function codexSessionMeta(sessionId: string, cwd: string, messages: readonly AgentMessage[]) {
  const timestamp = new Date(messages[0]?.timestamp ?? Date.now()).toISOString();
  const id = stableCodexThreadId(sessionId);
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      timestamp,
      cwd,
      originator: 'minimax_plugin_hook_projection',
      cli_version: 'minimax-plugin-hook-projection-v1',
      model_provider: null,
      base_instructions: null,
    },
  };
}

function stableCodexThreadId(sessionId: string): string {
  const hex = createHash('sha256').update(sessionId).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex
    .slice(12, 16)
    .join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function codexRolloutRows(message: AgentMessage): readonly unknown[] {
  const timestamp = new Date(message.timestamp).toISOString();
  const wrap = (payload: unknown) => ({ timestamp, type: 'response_item', payload });
  if (message.role === 'user') {
    const content = normalizedContentBlocks(message.content);
    return [
      wrap({
        type: 'message',
        role: 'user',
        content: content.map((part) => ({ type: 'input_text', text: part.text })),
      }),
    ];
  }
  if (message.role === 'assistant') {
    const text = message.content.filter((part) => part.type === 'text');
    const calls = message.content.filter((part) => part.type === 'toolCall');
    return [
      ...(text.length
        ? [
            wrap({
              type: 'message',
              role: 'assistant',
              content: text.map((part) => ({ type: 'output_text', text: part.text })),
            }),
          ]
        : []),
      ...calls.map((call) =>
        wrap({
          type: 'function_call',
          name: call.name,
          arguments: JSON.stringify(call.arguments),
          call_id: call.id,
        }),
      ),
    ];
  }
  if (message.role === 'toolResult') {
    return [
      wrap({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content.map((part) => normalizedContentPart(part).text).join('\n'),
      }),
    ];
  }
  const fallback = message as unknown as Readonly<Record<string, unknown>>;
  return [
    wrap({
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: normalizedContentBlocks(fallback.content ?? JSON.stringify(fallback))
            .map((part) => part.text)
            .join('\n'),
        },
      ],
    }),
  ];
}

function normalizedContentBlocks(
  value: unknown,
): Array<{ readonly type: 'text'; readonly text: string }> {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) {
    return [{ type: 'text', text: JSON.stringify(value) ?? String(value) }];
  }
  const blocks: Array<{ readonly type: 'text'; readonly text: string }> = [];
  for (const part of value) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const record = part as Readonly<Record<string, unknown>>;
    if (record.type === 'text' && typeof record.text === 'string') {
      blocks.push({ type: 'text', text: record.text });
      continue;
    }
    if (
      record.type === 'image' &&
      typeof record.data === 'string' &&
      typeof record.mimeType === 'string'
    ) {
      blocks.push({ type: 'text', text: `[image omitted: ${record.mimeType}]` });
    }
  }
  return blocks;
}

function normalizedContentPart(value: unknown): { readonly type: 'text'; readonly text: string } {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    if (record.type === 'text' && typeof record.text === 'string') {
      return { type: 'text', text: record.text };
    }
    if (record.type === 'image' && typeof record.mimeType === 'string') {
      return { type: 'text', text: `[image omitted: ${record.mimeType}]` };
    }
  }
  return { type: 'text', text: JSON.stringify(value) ?? String(value) };
}

async function appendBoundedJsonl(
  path: string,
  rows: readonly unknown[],
  maxBytes: number,
  preserveFirst: boolean,
): Promise<void> {
  if (rows.length === 0) return;
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // A missing projection is recreated from the current delta.
  }
  const existingRows = parseJsonLines(existing);
  await writeJsonl(path, [...existingRows, ...rows], maxBytes, preserveFirst);
}

async function appendCodexBoundedJsonl(
  path: string,
  sessionMeta: unknown,
  rows: readonly unknown[],
  maxBytes: number,
): Promise<void> {
  if (rows.length === 0) return;
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    // Recreate a complete Codex rollout if external cleanup removed the projection.
  }
  const existingRows = parseJsonLines(existing);
  const first = existingRows[0] as Readonly<Record<string, unknown>> | undefined;
  const completeRows =
    first?.type === 'session_meta' ? existingRows : [sessionMeta, ...existingRows];
  await writeJsonl(path, [...completeRows, ...rows], maxBytes, true);
}

async function writeJsonl(
  path: string,
  rows: readonly unknown[],
  maxBytes: number,
  preserveFirst: boolean,
): Promise<void> {
  const text = boundedJsonl(rows, maxBytes, preserveFirst);
  await writeFile(path, text, { encoding: 'utf8', mode: TRANSCRIPT_FILE_MODE });
}

function boundedJsonl(rows: readonly unknown[], maxBytes: number, preserveFirst: boolean): string {
  if (rows.length === 0) return '';
  const serialized = rows.map((row) => JSON.stringify(row));
  const first = preserveFirst ? serialized[0] : undefined;
  const tail = preserveFirst ? serialized.slice(1) : serialized;
  let used = first ? Buffer.byteLength(`${first}\n`) : 0;
  const kept: string[] = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const row = tail[index];
    if (row === undefined) continue;
    const bytes = Buffer.byteLength(`${row}\n`);
    if (used + bytes > maxBytes) continue;
    kept.unshift(row);
    used += bytes;
  }
  return [...(first ? [first] : []), ...kept].map((row) => `${row}\n`).join('');
}

function parseJsonLines(text: string): unknown[] {
  return text
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

async function maintainTranscriptDirectory(
  directory: string,
  input: {
    readonly nowMs: number;
    readonly maxAgeMs: number;
    readonly maxDirectoryBytes: number;
    readonly protectedPaths: ReadonlySet<string>;
  },
): Promise<void> {
  const protectedPaths = new Set([...input.protectedPaths, ...activeTranscriptPathOwners.keys()]);
  let names: string[];
  try {
    names = (await readdir(directory)).filter(isTranscriptFileName);
  } catch {
    return;
  }
  const files: Array<{ path: string; size: number; modifiedAtMs: number }> = [];
  for (let offset = 0; offset < names.length; offset += MAINTENANCE_STAT_BATCH_SIZE) {
    const batch = names.slice(offset, offset + MAINTENANCE_STAT_BATCH_SIZE);
    const batchMetadata = await Promise.all(
      batch.map(async (name) => {
        const path = join(directory, name);
        try {
          const entryMetadata = await stat(path);
          return entryMetadata.isFile()
            ? { path, size: entryMetadata.size, modifiedAtMs: entryMetadata.mtimeMs }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    files.push(
      ...batchMetadata.filter((file): file is NonNullable<typeof file> => file !== undefined),
    );
  }
  for (const file of files) {
    if (!protectedPaths.has(file.path) && input.nowMs - file.modifiedAtMs > input.maxAgeMs) {
      await rm(file.path, { force: true }).catch(() => undefined);
      file.size = 0;
    }
  }
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  for (const file of [...files].sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)) {
    if (totalBytes <= input.maxDirectoryBytes) break;
    if (file.size === 0 || protectedPaths.has(file.path)) continue;
    await rm(file.path, { force: true }).catch(() => undefined);
    totalBytes -= file.size;
  }
}

function retainTranscriptPaths(paths: readonly string[], owner: symbol): void {
  for (const path of paths) {
    const owners = activeTranscriptPathOwners.get(path) ?? new Set<symbol>();
    owners.add(owner);
    activeTranscriptPathOwners.set(path, owners);
  }
}

function releaseTranscriptPaths(paths: readonly string[], owner: symbol): boolean {
  for (const path of paths) {
    const owners = activeTranscriptPathOwners.get(path);
    if (!owners) continue;
    owners.delete(owner);
    if (owners.size === 0) activeTranscriptPathOwners.delete(path);
  }
  return paths.every((path) => !activeTranscriptPathOwners.has(path));
}

function isTranscriptFileName(name: string): boolean {
  return TRANSCRIPT_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
