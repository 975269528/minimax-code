import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  PluginHookCommandHandler,
  PluginHookDecision,
  PluginHookEventInput,
} from './contracts.js';

const COMPATIBLE_OUTPUT_STRING_LIMIT = 10_000;
const CODEX_DEFAULT_ADDITIONAL_CONTEXT_TOKEN_LIMIT = 2_500;
const MAX_INJECTED_TEXT_CHARS = 64 * 1024;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_SESSION_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ARTIFACT_FILES = 64;
const MAX_MANAGED_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MANAGED_OUTPUT_ROOT = join(tmpdir(), 'minimax-plugin-hooks', 'outputs');

const directoryLanes = new Map<string, Promise<void>>();
const activeArtifactDirectories = new Set<string>();
let startupGc: Promise<void> | undefined;

export async function boundHandlerDecision(
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
  decision: PluginHookDecision,
): Promise<PluginHookDecision> {
  const limit = handlerOutputLimit(handler);
  if (limit === undefined) return decision;
  const bound = (value: string | undefined, label: string) =>
    value === undefined
      ? Promise.resolve(undefined)
      : spillOversizedHookText(value, limit, handler, input.sessionId, label);
  const [
    reason,
    additionalContext,
    stopReason,
    systemMessage,
    terminalSequence,
    continuePrompt,
    postToolFeedback,
  ] = await Promise.all([
    bound(decision.reason, 'reason'),
    bound(decision.additionalContext, 'additional-context'),
    bound(decision.stopReason, 'stop-reason'),
    bound(decision.systemMessage, 'system-message'),
    bound(decision.terminalSequence, 'terminal-sequence'),
    bound(decision.continuePrompt, 'continue-prompt'),
    bound(decision.postToolFeedback, 'post-tool-feedback'),
  ]);
  const updatedResult =
    handler.sourceFormat === 'CLAUDE' && decision.updatedResult !== undefined
      ? await boundHookOutputValue(
          decision.updatedResult,
          limit,
          handler,
          input.sessionId,
          'updated-result',
        )
      : decision.updatedResult;
  return {
    ...decision,
    ...(reason === undefined ? {} : { reason }),
    ...(additionalContext === undefined ? {} : { additionalContext }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(systemMessage === undefined ? {} : { systemMessage }),
    ...(terminalSequence === undefined ? {} : { terminalSequence }),
    ...(continuePrompt === undefined ? {} : { continuePrompt }),
    ...(postToolFeedback === undefined ? {} : { postToolFeedback }),
    ...(updatedResult === undefined ? {} : { updatedResult }),
  };
}

export async function cleanupPluginHookSessionArtifacts(
  handlers: readonly PluginHookCommandHandler[],
  sessionId: string,
): Promise<void> {
  const directories = new Set(handlers.map((handler) => artifactDirectory(handler, sessionId)));
  await withDirectoryLane(MANAGED_OUTPUT_ROOT, async () => {
    for (const directory of directories) activeArtifactDirectories.delete(directory);
    await Promise.allSettled(
      [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });
}

function handlerOutputLimit(
  handler: PluginHookCommandHandler,
): { readonly kind: 'characters' | 'tokens'; readonly value: number } | undefined {
  if (handler.sourceFormat === 'CLAUDE') {
    return { kind: 'characters', value: COMPATIBLE_OUTPUT_STRING_LIMIT };
  }
  if (handler.sourceFormat === 'CODEX') {
    const value = handler.additionalContextLimit ?? CODEX_DEFAULT_ADDITIONAL_CONTEXT_TOKEN_LIMIT;
    return value === 0 ? undefined : { kind: 'tokens', value };
  }
  return { kind: 'characters', value: MAX_INJECTED_TEXT_CHARS };
}

async function boundHookOutputValue(
  value: unknown,
  limit: { readonly kind: 'characters' | 'tokens'; readonly value: number },
  handler: PluginHookCommandHandler,
  sessionId: string,
  label: string,
): Promise<unknown> {
  if (typeof value === 'string') {
    return spillOversizedHookText(value, limit, handler, sessionId, label);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const [index, item] of value.entries()) {
      result.push(await boundHookOutputValue(item, limit, handler, sessionId, `${label}-${index}`));
    }
    return result;
  }
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = await boundHookOutputValue(child, limit, handler, sessionId, `${label}-${key}`);
  }
  return result;
}

async function spillOversizedHookText(
  value: string,
  limit: { readonly kind: 'characters' | 'tokens'; readonly value: number },
  handler: PluginHookCommandHandler,
  sessionId: string,
  label: string,
): Promise<string> {
  if (!exceedsTextLimit(value, limit)) return value;
  const directory = artifactDirectory(handler, sessionId);
  const path = join(directory, `${randomUUID()}-${safeName(label)}.txt`);
  const footer = `\n\nFull hook output saved to: ${path}`;
  try {
    startupGc ??= garbageCollectManagedArtifacts();
    await startupGc;
    await withDirectoryLane(MANAGED_OUTPUT_ROOT, async () => {
      activeArtifactDirectories.add(directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await enforceManagedRootQuota(Buffer.byteLength(value));
      await enforceDirectoryQuota(directory, Buffer.byteLength(value));
      await writeFile(path, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    });
    return previewWithinLimit(value, footer, limit);
  } catch {
    return previewWithinLimit(value, '', limit);
  }
}

function artifactDirectory(handler: PluginHookCommandHandler, sessionId: string): string {
  return join(
    MANAGED_OUTPUT_ROOT,
    stableKey(`${handler.pluginName}\0${handler.pluginRoot}`),
    stableKey(sessionId),
  );
}

async function withDirectoryLane<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const previous = directoryLanes.get(directory) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  directoryLanes.set(directory, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (directoryLanes.get(directory) === tail) directoryLanes.delete(directory);
  }
}

async function enforceDirectoryQuota(directory: string, incomingBytes: number): Promise<void> {
  const names = await readdir(directory);
  const entries = (
    await Promise.all(
      names.map(async (name) => {
        const path = join(directory, name);
        try {
          const metadata = await stat(path);
          return metadata.isFile()
            ? { path, size: metadata.size, modifiedAt: metadata.mtimeMs }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((left, right) => left.modifiedAt - right.modifiedAt);
  const bytes = entries.reduce((total, entry) => total + entry.size, 0);
  if (
    entries.length >= MAX_SESSION_ARTIFACT_FILES ||
    bytes + incomingBytes > MAX_SESSION_ARTIFACT_BYTES
  ) {
    throw new Error('Plugin Hook output exceeds the managed artifact quota.');
  }
}

async function enforceManagedRootQuota(incomingBytes: number): Promise<void> {
  if (incomingBytes > MAX_MANAGED_ARTIFACT_BYTES) {
    throw new Error('Plugin Hook output exceeds the managed artifact root quota.');
  }
  const directories = await readManagedArtifactDirectories();
  let totalBytes = directories.reduce((total, directory) => total + directory.size, 0);
  for (const directory of directories.sort((left, right) => left.modifiedAt - right.modifiedAt)) {
    if (totalBytes + incomingBytes <= MAX_MANAGED_ARTIFACT_BYTES) break;
    if (activeArtifactDirectories.has(directory.path)) continue;
    await rm(directory.path, { recursive: true, force: true });
    totalBytes -= directory.size;
  }
  if (totalBytes + incomingBytes > MAX_MANAGED_ARTIFACT_BYTES) {
    throw new Error('Plugin Hook output exceeds the managed artifact root quota.');
  }
}

async function readManagedArtifactDirectories(): Promise<
  Array<{ readonly path: string; readonly size: number; readonly modifiedAt: number }>
> {
  let plugins;
  try {
    plugins = await readdir(MANAGED_OUTPUT_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const directories = await Promise.all(
    plugins
      .filter((plugin) => plugin.isDirectory())
      .map(async (plugin) => {
        const pluginDirectory = join(MANAGED_OUTPUT_ROOT, plugin.name);
        const sessions = await readdir(pluginDirectory, { withFileTypes: true }).catch(() => []);
        return Promise.all(
          sessions
            .filter((session) => session.isDirectory())
            .map(async (session) => {
              const directory = join(pluginDirectory, session.name);
              const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
              const metadata = await Promise.all(
                files
                  .filter((file) => file.isFile())
                  .map((file) => lstat(join(directory, file.name)).catch(() => undefined)),
              );
              const regularFiles = metadata.filter(
                (item): item is NonNullable<typeof item> => item?.isFile() === true,
              );
              return {
                path: directory,
                size: regularFiles.reduce((total, item) => total + item.size, 0),
                modifiedAt: regularFiles.reduce(
                  (latest, item) => Math.max(latest, item.mtimeMs),
                  0,
                ),
              };
            }),
        );
      }),
  );
  return directories.flat();
}

async function garbageCollectManagedArtifacts(): Promise<void> {
  const cutoff = Date.now() - ARTIFACT_TTL_MS;
  try {
    const plugins = await readdir(MANAGED_OUTPUT_ROOT);
    await Promise.allSettled(
      plugins.map(async (plugin) => {
        const pluginDirectory = join(MANAGED_OUTPUT_ROOT, plugin);
        const sessions = await readdir(pluginDirectory);
        await Promise.allSettled(
          sessions.map(async (session) => {
            const directory = join(pluginDirectory, session);
            if (activeArtifactDirectories.has(directory)) return;
            const metadata = await stat(directory);
            if (metadata.mtimeMs < cutoff) await rm(directory, { recursive: true, force: true });
          }),
        );
      }),
    );
  } catch {
    // The managed root normally does not exist before the first oversized output.
  }
}

function exceedsTextLimit(
  value: string,
  limit: { readonly kind: 'characters' | 'tokens'; readonly value: number },
): boolean {
  return textCost(value, limit.kind) > textBudget(limit);
}

function previewWithinLimit(
  value: string,
  footer: string,
  limit: { readonly kind: 'characters' | 'tokens'; readonly value: number },
): string {
  const limitBudget = textBudget(limit);
  const boundedFooter = textCost(footer, limit.kind) <= limitBudget ? footer : '';
  const footerCost = textCost(boundedFooter, limit.kind);
  const previewBudget = Math.max(0, limitBudget - footerCost);
  if (textCost(value, limit.kind) <= previewBudget) return `${value}${boundedFooter}`;
  const fullMarker = '\n... hook output truncated ...\n';
  const marker = textCost(fullMarker, limit.kind) <= previewBudget ? fullMarker : '';
  const bodyBudget = Math.max(0, previewBudget - textCost(marker, limit.kind));
  const points = [...value];
  let left = 0;
  let right = points.length;
  let head = '';
  let tail = '';
  let headCost = 0;
  let tailCost = 0;
  while (left < right) {
    const fromHead = headCost <= tailCost;
    const point = fromHead ? points[left++] : points[--right];
    if (point === undefined) break;
    const cost = textCost(point, limit.kind);
    if (headCost + tailCost + cost > bodyBudget) break;
    if (fromHead) {
      head += point;
      headCost += cost;
    } else {
      tail = point + tail;
      tailCost += cost;
    }
  }
  return `${head}${marker}${tail}${boundedFooter}`;
}

function textCost(value: string, kind: 'characters' | 'tokens'): number {
  if (kind === 'characters') return value.length;
  let units = 0;
  for (const point of value) units += point.charCodeAt(0) <= 0x7f ? 1 : 4;
  return units;
}

function textBudget(limit: {
  readonly kind: 'characters' | 'tokens';
  readonly value: number;
}): number {
  return limit.kind === 'characters' ? limit.value : limit.value * 4;
}

function stableKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 80) || 'output';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
