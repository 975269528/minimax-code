import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { structuredPatch } from 'diff';
import type { FileChangeObservation } from '@mavis/agent-tools/desktop';
import { BRAND } from '@mavis/config';
import type {
  HookRegistration,
  PostToolUseInput,
  PostToolUseOutput,
  PreToolUseInput,
  PreToolUseOutput,
} from '../hooks/engine/index.js';

import type {
  LocalFileDiff,
  LocalTurnDiffRecord,
  LocalTurnDiffSnapshotEntry,
  LocalTurnDiffStore,
  LocalTurnDiffToolCapture,
  LocalTurnDiffUndoEntry,
} from '../persistence/ports.js';
import type { LocalSessionRecord } from '../sessions/controller.js';

const MAX_TEXT_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_PATHS_PER_TOOL = 64;
const MAX_CAPTURE_TOTAL_TEXT_BYTES = MAX_TEXT_SNAPSHOT_BYTES * 2;
const SNAPSHOT_CAPTURE_CONCURRENCY = 4;
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
/**
 * Number of unchanged lines to keep as context on either side of each hunk
 * so the reviewer can see *where* the change is. Matches the common
 * `git apply` / `diff -U3` default and is small enough to keep the diff
 * readable when only a single line in the middle of a long file changed.
 */
const PATCH_CONTEXT_LINES = 3;
/**
 * Upper bound on the Myers edit distance explored by jsdiff before giving up.
 * Precise diffs only matter for small, local edits — exactly the inputs where
 * Myers is fast. A near-total rewrite of a large file blows up the O(N·D)
 * search *and* produces a diff that renders as all-red/all-green anyway, so
 * past this budget we fall back to the whole-file deletion+addition hunk.
 */
const MAX_DIFF_EDIT_LENGTH = 2000;
const STRUCTURED_WRITE_TOOLS = new Set([
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'file_edit',
  'apply_patch',
  'notebookedit',
  'notebook_edit',
  'str_replace_editor',
]);
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh', 'powershell', 'pwsh']);
const SHELL_CONTROL_TOKENS = new Set(['&&', '||', ';', '|']);
const TURN_FILE_CHANGE_FILTER_DIR_NAMES = new Set(['.git', '.harness-def']);
const TURN_FILE_CHANGE_FILTER_PREFIXES = [
  '.git/',
  '.harness-def/',
  `${BRAND.APP_DIR}/plans/`,
  `${BRAND.APP_DIR}/handoffs/`,
] as const;

export interface BeginLocalTurnFileChangeResult {
  turnId: string;
  fileChange?: FileChangeObservation;
  changedFiles?: string[];
  observationNotes?: string[];
}

export interface LocalFileChangeObservationResult {
  fileChange: FileChangeObservation;
  changedFiles?: string[];
  observationNotes: string[];
}

/**
 * Ephemeral, per-tool artifact progress used by in-process convergence observers.
 * Raw target identities and snapshot hashes must not be persisted or emitted by
 * those observers; they are scoped to the active Turn and discarded on settle.
 */
export interface LocalToolArtifactProgressObservation {
  toolCallId: string;
  loopKey: readonly string[];
  progressKey: readonly {
    file: string;
    state: string;
  }[];
  artifactChanged: boolean;
}

export interface FinalizeLocalTurnFileChangesResult extends LocalFileChangeObservationResult {
  captured: boolean;
  reason?: string;
  changeSetId?: string;
  assistantMessageId?: string;
  fileCount?: number;
}

export interface CaptureLocalToolUseInput {
  sessionId: string;
  agentName?: string;
  turnId?: string;
  toolName: string;
  toolCallId?: string;
  toolArgs: Record<string, unknown>;
}

export interface ApplyLocalTurnDiffMutationResult {
  success: boolean;
  reason?: 'not_undoable' | 'not_latest' | 'conflict' | 'unsafe_path';
}

export class LocalTurnFileChangeCaptureService {
  private static readonly MAX_PENDING_PROGRESS = 256;
  private readonly toolProgress = new Map<string, LocalToolArtifactProgressObservation>();

  constructor(
    private readonly store: LocalTurnDiffStore,
    private readonly options: {
      nowMs: () => number;
      makeId: (prefix: string) => string;
      reportFailure?: (sessionId: string, message: string) => void;
    },
  ) {}

  async begin(
    session: LocalSessionRecord,
    turnId: string,
  ): Promise<BeginLocalTurnFileChangeResult | undefined> {
    this.clearToolProgress(session.sessionId);
    if (!session.workspaceDir) return undefined;
    await this.store.markOtherPendingTurnsFinalized(session.sessionId, turnId, 'superseded');
    await this.store.createTurn({
      turnId,
      sessionId: session.sessionId,
      agentName: session.agentName,
      workspaceDir: session.workspaceDir,
    });
    return { turnId };
  }

  async captureToolUseStart(input: CaptureLocalToolUseInput): Promise<void> {
    if (!input.toolCallId) return;
    const turn = await this.store.getPendingTurn(input.sessionId);
    if (!turn) return;
    if (input.turnId && input.turnId !== turn.turnId) return;

    const extracted = extractToolWritePaths(turn.workspaceDir, input.toolName, input.toolArgs);
    if (extracted.kind === 'ignore') return;
    if (extracted.kind === 'ambiguous') {
      await this.store.markToolCaptureAmbiguous({
        captureId: makeCaptureId(),
        turnId: turn.turnId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        reason: extracted.reason,
      });
      return;
    }

    const paths = limitCapturePaths(extracted.paths);
    const before = await snapshotCapturedFiles(turn.workspaceDir, paths);
    await this.store.createToolCapture({
      captureId: makeCaptureId(),
      turnId: turn.turnId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      paths,
      before,
      ...(extracted.ambiguityReason ? { ambiguityReason: extracted.ambiguityReason } : {}),
    });
  }

  async captureToolUseFinish(input: CaptureLocalToolUseInput): Promise<void> {
    if (!input.toolCallId) return;
    const turn = await this.store.getPendingTurn(input.sessionId);
    if (!turn) return;
    if (input.turnId && input.turnId !== turn.turnId) return;

    const startedCapture = await this.store.getStartedToolCapture(
      turn.turnId,
      input.sessionId,
      input.toolCallId,
    );
    const extracted = startedCapture
      ? undefined
      : extractToolWritePaths(turn.workspaceDir, input.toolName, input.toolArgs);
    const paths = startedCapture?.paths ?? (extracted?.kind === 'paths' ? extracted.paths : []);
    if (paths.length === 0) return;
    const after = await snapshotCapturedFiles(turn.workspaceDir, limitCapturePaths(paths));
    const completed = await this.store.completeToolCapture({
      turnId: turn.turnId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      after,
    });
    if (!completed || !startedCapture) return;
    const observation = buildToolArtifactProgressObservation({
      ...startedCapture,
      after,
      status: 'completed',
      completedAtMs: this.options.nowMs(),
    });
    if (observation) {
      this.toolProgress.set(
        toolProgressKey(input.sessionId, turn.turnId, input.toolCallId),
        observation,
      );
      if (this.toolProgress.size > LocalTurnFileChangeCaptureService.MAX_PENDING_PROGRESS) {
        const oldest = this.toolProgress.keys().next().value;
        if (oldest !== undefined) this.toolProgress.delete(oldest);
      }
    }
  }

  takeToolArtifactProgress(input: {
    sessionId: string;
    turnId: string;
    toolCallIds: readonly string[];
  }): readonly LocalToolArtifactProgressObservation[] {
    return input.toolCallIds.flatMap((toolCallId) => {
      const key = toolProgressKey(input.sessionId, input.turnId, toolCallId);
      const observation = this.toolProgress.get(key);
      this.toolProgress.delete(key);
      return observation ? [observation] : [];
    });
  }

  getToolCaptureHookRegistrations(): Array<
    HookRegistration<unknown, PreToolUseOutput | PostToolUseOutput>
  > {
    return [
      {
        id: 'builtin:turn-file-change-capture:PreToolUse',
        hookEvent: 'PreToolUse',
        priority: 1_000,
        timeout: 10_000,
        handler: async (input, output) => {
          const hookInput = input as PreToolUseInput;
          const hookOutput = output as PreToolUseOutput;
          await this.captureToolUseStart(
            toCaptureToolUseInput(hookInput, hookOutput.toolArgs ?? hookInput.toolArgs),
          );
        },
      },
      {
        id: 'builtin:turn-file-change-capture:PostToolUse',
        hookEvent: 'PostToolUse',
        priority: 1,
        timeout: 10_000,
        handler: async (input) => {
          const hookInput = input as PostToolUseInput;
          await this.captureToolUseFinish(toCaptureToolUseInput(hookInput, hookInput.toolArgs));
        },
      },
    ];
  }

  async finalizeLatestPending(
    sessionId: string,
    options: { assistantMessageId?: string; turnId?: string } = {},
  ): Promise<FinalizeLocalTurnFileChangesResult> {
    this.clearToolProgress(sessionId, options.turnId);
    const turn = await this.store.getPendingTurn(sessionId);
    if (!turn) {
      return {
        captured: false,
        reason: 'turn_not_found',
        fileChange: 'recording_failed',
        observationNotes: ['local_turn_diff_turn_not_found'],
      };
    }
    if (options.turnId && turn.turnId !== options.turnId) {
      return {
        captured: false,
        reason: 'turn_not_found',
        fileChange: 'recording_failed',
        observationNotes: ['local_turn_diff_turn_not_found'],
      };
    }
    const assistantMessageId = options.assistantMessageId;

    try {
      const captures = await this.store.listCompletedToolCaptures(sessionId, turn.turnId);
      const merged = mergeToolCaptures(captures);
      const fileChanges: LocalFileDiff[] = [];
      const undo: LocalTurnDiffUndoEntry[] = [];
      let undoable = true;

      for (const [file, snapshots] of merged) {
        const change = buildChangeFromSnapshots(file, snapshots.before, snapshots.after);
        if (!change.fileChange) continue;
        fileChanges.push(change.fileChange);
        if (change.undo) undo.push(change.undo);
        if (!change.undoable) undoable = false;
      }

      const observation = buildFileChangeObservation(captures, fileChanges);

      if (!assistantMessageId) {
        await this.finishPendingTurn(sessionId, turn.turnId, 'empty');
        return {
          ...observation,
          captured: false,
          reason: 'assistant_message_not_found',
        };
      }

      if (fileChanges.length === 0) {
        await this.finishPendingTurn(sessionId, turn.turnId, 'empty');
        return {
          ...observation,
          captured: false,
          reason: observation.fileChange === 'uncertain' ? 'ambiguous_capture' : 'empty_diff',
          assistantMessageId,
        };
      }

      const changeSetId = this.options.makeId('cs');
      const now = this.options.nowMs();
      await this.store.upsert({
        changeSetId,
        sessionId,
        agentName: turn.agentName,
        turnId: turn.turnId,
        assistantMessageId,
        workspaceDir: turn.workspaceDir,
        capturedAtMs: now,
        updatedAtMs: now,
        status: 'active',
        fileChanges,
        undo,
        undoable,
      });
      await this.finishPendingTurn(sessionId, turn.turnId, 'finalized');
      return {
        ...observation,
        captured: true,
        changeSetId,
        assistantMessageId,
        fileCount: fileChanges.length,
      };
    } catch (err) {
      await this.finishPendingTurn(sessionId, turn.turnId, 'failed').catch(() => undefined);
      const message = `local_turn_diff_finalize_failed:${err instanceof Error ? err.message : String(err)}`;
      this.options.reportFailure?.(sessionId, message);
      return {
        captured: false,
        reason: 'capture_failed',
        ...(assistantMessageId ? { assistantMessageId } : {}),
        fileChange: 'recording_failed',
        observationNotes: [message],
      };
    }
  }

  async markPendingFailed(sessionId: string, turnId?: string): Promise<void> {
    this.clearToolProgress(sessionId, turnId);
    const turn = await this.store.getPendingTurn(sessionId);
    if (!turn) return;
    if (turnId && turn.turnId !== turnId) return;
    await this.finishPendingTurn(sessionId, turn.turnId, 'failed');
  }

  private async finishPendingTurn(
    sessionId: string,
    turnId: string,
    status: 'finalized' | 'empty' | 'failed' | 'superseded',
  ): Promise<void> {
    await this.store.markTurnFinalized(sessionId, turnId, status);
    await this.store.markOtherPendingTurnsFinalized(sessionId, turnId, 'superseded');
  }

  private clearToolProgress(sessionId: string, turnId?: string): void {
    const prefix = turnId ? toolProgressKey(sessionId, turnId, '') : `${sessionId}\u0000`;
    for (const key of this.toolProgress.keys()) {
      if (key.startsWith(prefix)) this.toolProgress.delete(key);
    }
  }
}

export async function applyLocalTurnDiffSnapshotMutation(
  record: LocalTurnDiffRecord,
  action: 'revert' | 'reapply',
): Promise<ApplyLocalTurnDiffMutationResult> {
  if (!record.undoable || !record.undo || record.undo.length === 0) {
    return { success: false, reason: 'not_undoable' };
  }
  const sourceKey = action === 'revert' ? 'after' : 'before';
  const targetKey = action === 'revert' ? 'before' : 'after';
  for (const undo of record.undo) {
    const current = await snapshotCapturedFile(record.workspaceDir, undo.file);
    if (snapshotHash(current) !== snapshotHash(undo[sourceKey])) {
      return { success: false, reason: 'conflict' };
    }
  }

  for (const undo of record.undo) {
    const absolute = safeCapturedPath(record.workspaceDir, undo.file);
    if (!absolute) return { success: false, reason: 'unsafe_path' };
    const target = undo[targetKey];
    if (!target.exists) {
      await fs.rm(absolute, { force: true });
      continue;
    }
    if (target.content === undefined) return { success: false, reason: 'not_undoable' };
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, target.content, 'utf8');
  }
  return { success: true };
}

function makeCaptureId(): string {
  return `tcap_${randomUUID().replaceAll('-', '')}`;
}

function toolProgressKey(sessionId: string, turnId: string, toolCallId: string): string {
  return `${sessionId}\u0000${turnId}\u0000${toolCallId}`;
}

function toCaptureToolUseInput(
  hookInput: PreToolUseInput | PostToolUseInput,
  toolArgs: Record<string, unknown>,
): CaptureLocalToolUseInput {
  return {
    sessionId: hookInput.sessionId,
    agentName: hookInput.agentName,
    ...(hookInput.turnId ? { turnId: hookInput.turnId } : {}),
    toolName: hookInput.toolName,
    ...(hookInput.toolCallId ? { toolCallId: hookInput.toolCallId } : {}),
    toolArgs,
  };
}

type ExtractToolPathsResult =
  | { kind: 'ignore' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'paths'; paths: string[]; ambiguityReason?: string };

function extractToolWritePaths(
  workspaceDir: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): ExtractToolPathsResult {
  const normalizedToolName = toolName.toLowerCase().replaceAll('-', '_');
  const paths = new Set<string>();

  if (STRUCTURED_WRITE_TOOLS.has(normalizedToolName)) {
    const primaryPath = getStringArg(toolArgs, ['file_path', 'filePath', 'path']);
    if (primaryPath) {
      const relative = normalizeCapturePath(workspaceDir, primaryPath);
      if (relative) paths.add(relative);
    }
    const patch = getStringArg(toolArgs, ['patch', 'input', '_raw']);
    if (patch) {
      for (const filePath of parsePatchPaths(patch)) {
        const relative = normalizeCapturePath(workspaceDir, filePath);
        if (relative) paths.add(relative);
      }
    }
    return paths.size > 0 ? { kind: 'paths', paths: [...paths].sort() } : { kind: 'ignore' };
  }

  if (!SHELL_TOOLS.has(normalizedToolName)) return { kind: 'ignore' };
  const command = getStringArg(toolArgs, ['command', 'cmd', 'script', 'input', '_raw']);
  if (!command) return { kind: 'ignore' };

  for (const filePath of parsePatchPaths(command)) {
    const relative = normalizeCapturePath(workspaceDir, filePath);
    if (relative) paths.add(relative);
  }

  const tokens = shellTokenize(command);
  const ambiguous = [
    extractShellRedirectTargets(workspaceDir, tokens, paths),
    extractShellToolTargets(workspaceDir, tokens, paths),
    extractFormatterTargets(workspaceDir, tokens, paths),
  ].some(Boolean);

  if (paths.size > 0) {
    return {
      kind: 'paths',
      paths: [...paths].sort(),
      ...(ambiguous ? { ambiguityReason: 'shell_target_ambiguous' } : {}),
    };
  }
  return ambiguous ? { kind: 'ambiguous', reason: 'shell_target_ambiguous' } : { kind: 'ignore' };
}

function getStringArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function parsePatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /^\+\+\+ b\/(.+)$/gm,
    /^--- a\/(.+)$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of patch.matchAll(pattern)) {
      const filePath = match[1]?.trim();
      if (filePath && filePath !== '/dev/null') paths.push(filePath);
    }
  }
  return paths;
}

function extractShellRedirectTargets(
  workspaceDir: string,
  tokens: string[],
  paths: Set<string>,
): boolean {
  let ambiguous = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const separateRedirect = /^(?:\d+)?(?:>|>>|&>)$/.test(token);
    if (separateRedirect) {
      if (collectPathToken(workspaceDir, tokens[index + 1], paths) === 'ambiguous') {
        ambiguous = true;
      }
      index += 1;
      continue;
    }

    const attached = /^(?:\d+)?(?:>|>>|&>)(.+)$/.exec(token);
    if (attached?.[1] && collectPathToken(workspaceDir, attached[1], paths) === 'ambiguous') {
      ambiguous = true;
    }
  }
  return ambiguous;
}

function extractShellToolTargets(
  workspaceDir: string,
  tokens: string[],
  paths: Set<string>,
): boolean {
  let ambiguous = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const command = path.basename(token);

    if (command === 'tee') {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const target = tokens[cursor]!;
        if (SHELL_CONTROL_TOKENS.has(target)) break;
        if (target.startsWith('-')) continue;
        if (collectPathToken(workspaceDir, target, paths) === 'ambiguous') ambiguous = true;
      }
      continue;
    }

    if (command === 'cp' || command === 'mv') {
      const candidates = tokens
        .slice(index + 1)
        .filter((item) => !SHELL_CONTROL_TOKENS.has(item) && !item.startsWith('-'));
      if (candidates.length === 2) {
        if (
          command === 'mv' &&
          collectPathToken(workspaceDir, candidates[0], paths) === 'ambiguous'
        ) {
          ambiguous = true;
        }
        if (collectPathToken(workspaceDir, candidates[1], paths) === 'ambiguous') ambiguous = true;
      } else if (candidates.length > 2) {
        ambiguous = true;
      }
      continue;
    }

    if (
      command === 'sed' &&
      tokens.slice(index + 1).some((item) => item === '-i' || item.startsWith('-i'))
    ) {
      const editFlagIndex = tokens.findIndex(
        (item, itemIndex) => itemIndex > index && (item === '-i' || item.startsWith('-i')),
      );
      if (editFlagIndex >= 0) {
        let cursor = editFlagIndex + 1;
        if (tokens[editFlagIndex] === '-i' && tokens[cursor] === '') cursor += 1;
        cursor += 1;
        for (; cursor < tokens.length; cursor += 1) {
          const target = tokens[cursor]!;
          if (SHELL_CONTROL_TOKENS.has(target)) break;
          if (target.startsWith('-')) continue;
          if (collectPathToken(workspaceDir, target, paths) === 'ambiguous') ambiguous = true;
        }
      }
    }
  }
  return ambiguous;
}

function extractFormatterTargets(
  workspaceDir: string,
  tokens: string[],
  paths: Set<string>,
): boolean {
  let ambiguous = false;
  const writeFlagIndex = tokens.findIndex((token) => token === '--write' || token === '--fix');
  if (writeFlagIndex < 0) return false;
  for (let index = writeFlagIndex + 1; index < tokens.length; index += 1) {
    const target = tokens[index]!;
    if (SHELL_CONTROL_TOKENS.has(target)) break;
    if (target.startsWith('-')) continue;
    if (collectPathToken(workspaceDir, target, paths) === 'ambiguous') ambiguous = true;
  }
  return ambiguous;
}

function collectPathToken(
  workspaceDir: string,
  token: string | undefined,
  paths: Set<string>,
): 'ok' | 'ambiguous' {
  if (!token || isDiscardTarget(token)) return 'ok';
  if (hasDynamicShellPathToken(token)) return 'ambiguous';
  const relative = normalizeCapturePath(workspaceDir, token);
  if (!relative) return token === '.' || token.endsWith('/') ? 'ambiguous' : 'ok';
  paths.add(relative);
  return 'ok';
}

function normalizeCapturePath(workspaceDir: string, filePath: string): string | undefined {
  let trimmed = filePath.trim();
  if (!trimmed || isDiscardTarget(trimmed)) return undefined;
  // Convert MSYS-style paths (/c/Users/...) to Windows paths on win32.
  // Git Bash output uses this format; path.resolve() would misinterpret it.
  if (process.platform === 'win32') {
    const msysMatch = trimmed.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (msysMatch) {
      const drive = msysMatch[1]!.toUpperCase();
      const rest = msysMatch[2]?.replace(/\//g, '\\') ?? '\\';
      trimmed = `${drive}:${rest}`;
    }
  }
  const root = path.resolve(workspaceDir);
  const absolute = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.win32.isAbsolute(trimmed)
      ? path.win32.resolve(trimmed)
      : path.resolve(root, trimmed);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) return absolute;
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || isFilteredRelativePath(relative)) return undefined;
  return relative;
}

function safeCapturedPath(workspaceDir: string, filePath: string): string | undefined {
  const normalized = normalizeCapturePath(workspaceDir, filePath);
  if (!normalized) return undefined;
  if (path.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) return normalized;
  return path.resolve(workspaceDir, normalized);
}

async function snapshotCapturedFile(
  workspaceDir: string,
  filePath: string,
  budget?: SnapshotReadBudget,
): Promise<LocalTurnDiffSnapshotEntry> {
  const normalized = normalizeCapturePath(workspaceDir, filePath);
  if (!normalized) return { file: filePath, exists: false };
  const absolute = safeCapturedPath(workspaceDir, normalized);
  if (!absolute) return { file: normalized, exists: false };
  try {
    const stats = await fs.stat(absolute);
    if (!stats.isFile()) return { file: normalized, exists: false };
    const metadataEntry: LocalTurnDiffSnapshotEntry = {
      file: normalized,
      exists: true,
      hash: metadataSnapshotHash(stats),
      sizeBytes: stats.size,
    };
    if (stats.size > MAX_TEXT_SNAPSHOT_BYTES) return { ...metadataEntry, oversized: true };
    if (budget && stats.size > budget.remainingTextBytes) {
      return { ...metadataEntry, oversized: true };
    }
    if (budget) budget.remainingTextBytes -= stats.size;
    const buffer = await readSmallFileBuffer(absolute, stats.size);
    if (!buffer) return { ...metadataEntry, oversized: true };
    const entry: LocalTurnDiffSnapshotEntry = {
      file: normalized,
      exists: true,
      hash: createHash('sha256').update(buffer).digest('hex'),
      sizeBytes: buffer.length,
    };
    if (buffer.includes(0)) return { ...entry, binary: true };
    if (!isValidUtf8(buffer)) return { ...entry, binary: true };
    return { ...entry, content: buffer.toString('utf8') };
  } catch {
    return { file: normalized, exists: false };
  }
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    FATAL_UTF8_DECODER.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

interface SnapshotReadBudget {
  remainingTextBytes: number;
}

async function snapshotCapturedFiles(
  workspaceDir: string,
  filePaths: string[],
): Promise<LocalTurnDiffSnapshotEntry[]> {
  const budget: SnapshotReadBudget = { remainingTextBytes: MAX_CAPTURE_TOTAL_TEXT_BYTES };
  return mapWithConcurrency(filePaths, SNAPSHOT_CAPTURE_CONCURRENCY, (filePath) =>
    snapshotCapturedFile(workspaceDir, filePath, budget),
  );
}

function limitCapturePaths(paths: string[]): string[] {
  return paths.slice(0, MAX_CAPTURE_PATHS_PER_TOOL);
}

async function readSmallFileBuffer(
  absolute: string,
  expectedSize: number,
): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) return undefined;
  if (expectedSize > MAX_TEXT_SNAPSHOT_BYTES) return undefined;
  const handle = await fs.open(absolute, 'r');
  try {
    if (expectedSize === 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(expectedSize);
    const { bytesRead } = await handle.read(buffer, 0, expectedSize, 0);
    if (bytesRead < expectedSize) return buffer.subarray(0, bytesRead);
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytesRead } = await handle.read(probe, 0, 1, expectedSize);
    if (extraBytesRead > 0) return undefined;
    return buffer;
  } finally {
    await handle.close();
  }
}

function metadataSnapshotHash(stats: { size: number; mtimeMs: number }): string {
  return `metadata:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildChangeFromSnapshots(
  file: string,
  before: LocalTurnDiffSnapshotEntry,
  after: LocalTurnDiffSnapshotEntry,
): { fileChange?: LocalFileDiff; undo?: LocalTurnDiffUndoEntry; undoable: boolean } {
  if (snapshotHash(before) === snapshotHash(after)) return { undoable: true };

  const undo: LocalTurnDiffUndoEntry = { file, before, after };
  const status = changeStatus(before, after);
  if (
    before.exists &&
    after.exists &&
    before.content !== undefined &&
    after.content !== undefined
  ) {
    return {
      fileChange: buildTextFileChange(file, before.content, after.content, status),
      undo,
      undoable: true,
    };
  }
  if (!before.exists && after.exists && after.content !== undefined) {
    return {
      fileChange: buildTextFileChange(file, '', after.content, status),
      undo,
      undoable: true,
    };
  }
  if (before.exists && !after.exists && before.content !== undefined) {
    return {
      fileChange: buildTextFileChange(file, before.content, '', status),
      undo,
      undoable: true,
    };
  }
  return {
    fileChange: {
      file,
      additions: 0,
      deletions: 0,
      status,
      ...(path.isAbsolute(file) || path.win32.isAbsolute(file) ? { external: true } : {}),
    },
    undo,
    undoable: false,
  };
}

function buildTextFileChange(
  file: string,
  before: string,
  after: string,
  status: LocalFileDiff['status'],
): LocalFileDiff {
  const oldFileName = `a/${file}`;
  const newFileName = `b/${file}`;
  const patch = buildStructuredPatch(oldFileName, newFileName, before, after);
  return {
    file,
    // Derive the counts from the exact hunks we render so the sidebar
    // `+N -N` badge always matches what the review panel shows.
    additions: countPatchLines(patch, '+'),
    deletions: countPatchLines(patch, '-'),
    status,
    diff: serializeUnifiedDiff(patch),
    patch,
    ...(path.isAbsolute(file) || path.win32.isAbsolute(file) ? { external: true } : {}),
  };
}

/**
 * Line-based structured patch between two text snapshots, scoped to the
 * actually-changed regions with `PATCH_CONTEXT_LINES` of context, so the
 * review panel no longer paints the whole file red+green for a single-line
 * edit. Identical contents produce an empty hunk list (the review panel
 * shows its "no diff" placeholder).
 *
 * When the edit distance exceeds `MAX_DIFF_EDIT_LENGTH` (a near-total
 * rewrite), jsdiff aborts and we fall back to the legacy whole-file
 * deletion+addition hunk — which is both cheap to build and a faithful
 * rendering of "everything changed".
 */
function buildStructuredPatch(
  oldFileName: string,
  newFileName: string,
  before: string,
  after: string,
): NonNullable<LocalFileDiff['patch']> {
  const patch = structuredPatch(oldFileName, newFileName, before, after, undefined, undefined, {
    context: PATCH_CONTEXT_LINES,
    maxEditLength: MAX_DIFF_EDIT_LENGTH,
  });
  if (patch) {
    return { oldFileName, newFileName, hunks: patch.hunks };
  }
  const beforeLines = splitPatchLines(before);
  const afterLines = splitPatchLines(after);
  return {
    oldFileName,
    newFileName,
    hunks: [
      {
        oldStart: 1,
        oldLines: beforeLines.length,
        newStart: 1,
        newLines: afterLines.length,
        lines: [...beforeLines.map((line) => `-${line}`), ...afterLines.map((line) => `+${line}`)],
      },
    ],
  };
}

function countPatchLines(patch: NonNullable<LocalFileDiff['patch']>, marker: '+' | '-'): number {
  let count = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith(marker)) count += 1;
    }
  }
  return count;
}

/** Render a structured patch as a unified-diff string (`---`/`+++`/`@@` hunks). */
function serializeUnifiedDiff(patch: NonNullable<LocalFileDiff['patch']>): string {
  const lines = [`--- ${patch.oldFileName}`, `+++ ${patch.newFileName}`];
  for (const hunk of patch.hunks) {
    lines.push(
      `@@ -${formatHunkRange(hunk.oldStart, hunk.oldLines)} +${formatHunkRange(
        hunk.newStart,
        hunk.newLines,
      )} @@`,
    );
    lines.push(...hunk.lines);
  }
  // Unified diffs are newline-terminated. The body always has at least the
  // `--- /+++` lines, so this never produces an empty string.
  return `${lines.join('\n')}\n`;
}

/** Render a unified-diff hunk range (`start` or `start,count`). */
function formatHunkRange(start: number, lineCount: number): string {
  if (lineCount === 0) return `${start},0`;
  return lineCount === 1 ? `${start}` : `${start},${lineCount}`;
}

function splitPatchLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
}

function snapshotHash(entry: LocalTurnDiffSnapshotEntry): string {
  if (!entry.exists) return 'missing';
  return entry.hash ?? `content:${entry.content ?? ''}`;
}

function changeStatus(
  before: LocalTurnDiffSnapshotEntry,
  after: LocalTurnDiffSnapshotEntry,
): LocalFileDiff['status'] {
  if (!before.exists && after.exists) return 'added';
  if (before.exists && !after.exists) return 'deleted';
  return 'modified';
}

function mergeToolCaptures(
  captures: LocalTurnDiffToolCapture[],
): Map<string, { before: LocalTurnDiffSnapshotEntry; after: LocalTurnDiffSnapshotEntry }> {
  const merged = new Map<
    string,
    { before: LocalTurnDiffSnapshotEntry; after: LocalTurnDiffSnapshotEntry }
  >();
  for (const capture of captures) {
    const beforeByFile = new Map(capture.before.map((entry) => [entry.file, entry]));
    const afterByFile = new Map(capture.after.map((entry) => [entry.file, entry]));
    for (const file of capture.paths) {
      const before = beforeByFile.get(file);
      const after = afterByFile.get(file);
      if (!before || !after) continue;
      const existing = merged.get(file);
      if (existing) {
        existing.after = after;
      } else {
        merged.set(file, { before, after });
      }
    }
  }
  return new Map([...merged.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function buildFileChangeObservation(
  captures: LocalTurnDiffToolCapture[],
  fileChanges: LocalFileDiff[],
): LocalFileChangeObservationResult {
  const changedFiles = [
    ...new Set(fileChanges.map((change) => change.file).filter(isWorkspaceRelativeObservationPath)),
  ].sort((left, right) => left.localeCompare(right));
  const ambiguousCaptures = captures.filter(
    (capture) => capture.status === 'ambiguous' || Boolean(capture.ambiguityReason),
  );
  if (ambiguousCaptures.length > 0) {
    return {
      fileChange: 'uncertain',
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      observationNotes: ambiguousCaptures.map(
        (capture) =>
          `ambiguous_tool_capture:${capture.toolCallId}:${capture.ambiguityReason ?? 'unknown'}`,
      ),
    };
  }
  if (fileChanges.length > 0) {
    return {
      fileChange: 'change_observed',
      ...(changedFiles.length > 0 ? { changedFiles } : {}),
      observationNotes: [],
    };
  }
  return {
    fileChange: 'no_observed_change',
    observationNotes: ['no_file_change_observed'],
  };
}

function buildToolArtifactProgressObservation(
  capture: LocalTurnDiffToolCapture,
): LocalToolArtifactProgressObservation | undefined {
  if (capture.status !== 'completed' || capture.ambiguityReason) return undefined;
  const beforeByFile = new Map(capture.before.map((entry) => [entry.file, entry]));
  const afterByFile = new Map(capture.after.map((entry) => [entry.file, entry]));
  const targets = capture.paths.filter(isWorkspaceRelativeObservationPath).sort();
  if (targets.length === 0) return undefined;

  let artifactChanged = false;
  const progressKey: Array<{ file: string; state: string }> = [];
  for (const file of targets) {
    const before = beforeByFile.get(file);
    const after = afterByFile.get(file);
    // Legacy snapshot errors share the "missing" representation with real absence.
    // V1 only certifies two content-hashed states; creation/deletion stays unknown.
    if (!before?.exists || !after?.exists || !before.hash || !after.hash) return undefined;
    const beforeState = snapshotHash(before);
    const afterState = snapshotHash(after);
    if (beforeState.startsWith('metadata:') || afterState.startsWith('metadata:')) return undefined;
    if (beforeState !== afterState) artifactChanged = true;
    progressKey.push({ file, state: afterState });
  }

  return {
    toolCallId: capture.toolCallId,
    loopKey: targets,
    progressKey,
    artifactChanged,
  };
}

function isWorkspaceRelativeObservationPath(file: string): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    !path.isAbsolute(normalized) &&
    !path.win32.isAbsolute(normalized) &&
    normalized !== '..' &&
    !normalized.startsWith('../')
  );
}

function hasDynamicShellPathToken(token: string): boolean {
  return (
    /\$\{?[\w@*]/.test(token) ||
    token.includes('$(') ||
    token.includes('`') ||
    /[*?[]/.test(token) ||
    token.startsWith('<(') ||
    token.startsWith('>(') ||
    token.startsWith('~')
  );
}

function isDiscardTarget(token: string): boolean {
  return (
    token === '/dev/null' ||
    token === '/dev/stdout' ||
    token === '/dev/stderr' ||
    token === '/dev/tty' ||
    /^&\d+$/.test(token) ||
    token === '&-'
  );
}

function isFilteredRelativePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => TURN_FILE_CHANGE_FILTER_DIR_NAMES.has(part))) return true;
  if (
    parts.some(
      (part, index) =>
        part === BRAND.APP_DIR && (parts[index + 1] === 'plans' || parts[index + 1] === 'handoffs'),
    )
  ) {
    return true;
  }
  return TURN_FILE_CHANGE_FILTER_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function shellTokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  const flush = (): void => {
    if (current.length > 0) tokens.push(current);
    current = '';
  };

  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      const next = input[index + 1];
      if (next === '\n') {
        index += 1;
        continue;
      }
      if (next === '\r' && input[index + 2] === '\n') {
        index += 2;
        continue;
      }
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (isShellWhitespace(ch) && !inSingleQuote && !inDoubleQuote) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return tokens;
}

function isShellWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
}
