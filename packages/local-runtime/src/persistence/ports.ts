import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import type { LocalQueuedMessage } from '../messages/queue.js';

export interface LocalAgentRecord {
  name: string;
  displayName: string;
  description?: string;
  avatar?: string;
  persona?: string;
  systemPrompt?: string;
  defaultWorkspaceDir?: string;
  creationSource: 'manual' | 'auto';
  rootSessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface LocalRuntimeAgentStore {
  get(name: string): Promise<LocalAgentRecord | undefined>;
  upsert(record: LocalAgentRecord): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<LocalAgentRecord[]>;
}

export interface LocalRuntimeMessageStore {
  initSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  getDisplayMessages(sessionId: string): Promise<AgentMessage[]>;
  listDisplayMessages(
    sessionId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<{ messages: AgentMessage[]; nextCursor?: string; hasMore?: boolean }>;
  /**
   * Latest `limit` display messages in chronological order, with `role` and
   * the `<permission-response>` exclusion applied at the storage layer so the
   * limit counts matching messages (mirrors the daemon message store's
   * `getRecent` statements).
   */
  listRecentDisplayMessages(
    sessionId: string,
    opts: { limit: number; role?: string; excludePermissionResponses?: boolean },
  ): Promise<AgentMessage[]>;
  setDisplayMessages(sessionId: string, messages: AgentMessage[]): Promise<void>;
  upsertDisplayMessage(sessionId: string, message: AgentMessage): Promise<void>;
  /**
   * Batched, streaming-friendly display import. Upserts one batch of rows in a
   * single transaction so a large legacy migration can be written in bounded
   * chunks instead of materializing the whole session's display array (plus a
   * `cloneJson` copy) at once. Pass `replaceExisting: true` on the FIRST batch
   * to clear the session's rows before the batch is written; subsequent batches
   * must omit it (or pass `false`) so earlier batches are preserved. Optional so
   * lightweight test doubles need not implement it (mirrors
   * `getLatestDisplayMessageRowId` / `deleteDisplayMessagesByIds`).
   */
  appendDisplayMessages?(
    sessionId: string,
    messages: AgentMessage[],
    opts?: { replaceExisting?: boolean },
  ): Promise<void>;
  /**
   * Remove the listed display rows by `msg_id`. Used by turn retraction to drop
   * the user-query bubble of a fully retracted turn. Optional so lightweight
   * test doubles need not implement it.
   */
  deleteDisplayMessagesByIds?(sessionId: string, msgIds: string[]): Promise<void>;
  getPiHistory(sessionId: string): Promise<PiAgentMessage[]>;
  setPiHistory(sessionId: string, messages: PiAgentMessage[]): Promise<void>;
  appendPiHistory(sessionId: string, messages: PiAgentMessage[]): Promise<void>;
}

export interface LocalRuntimeQueueStore {
  list(sessionId: string): Promise<LocalQueuedMessage[]>;
  replaceSession(sessionId: string, items: LocalQueuedMessage[]): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

/**
 * One deliverable asset of a session — the latest occurrence per `assetKey`
 * from the persisted session asset index (message deliverables, not drive
 * nodes; the DriveNode view mapping happens at the query adapter).
 */
export interface SessionAssetRecord {
  /** Row id of the winning occurrence (cursor tiebreaker). */
  rowId: number;
  msgId: string;
  role?: string;
  messageCreatedAtMs: number;
  assetKey: string;
  sourceTag: string;
  path: string;
  name?: string;
  assetType?: string;
  artifactId?: string;
  driveNodeId?: string;
}

export interface ListSessionAssetsResult {
  assets: SessionAssetRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface SessionAssetStore {
  /**
   * Bring the session's asset index up to date: no state → full scan of the
   * message rows; stale version → rebuild; lagging state → incremental scan.
   * Callers must run legacy message migration first so the rows exist.
   */
  ensureIndexed(sessionId: string): Promise<void>;
  /** Newest-first latest-occurrence-per-asset listing with cursor paging. */
  listAssets(
    sessionId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ListSessionAssetsResult>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface LocalTokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  turns: number;
}

export type LocalTokenUsageGroupBy = 'agent' | 'session' | 'model' | 'day';

export interface LocalTokenUsageRow {
  id: number;
  sessionId: string;
  agentName: string;
  frameworkType: string;
  turnId: string | null;
  model: string | null;
  ts: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  raw: string | null;
}

export interface LocalTokenUsageStore {
  append(usage: Omit<LocalTokenUsageRow, 'id'>): Promise<void>;
  listBySession(sessionId: string, opts?: { limit?: number }): Promise<LocalTokenUsageRow[]>;
  listByAgent(
    agentName: string,
    opts?: { from?: number; to?: number; limit?: number },
  ): Promise<LocalTokenUsageRow[]>;
  summarizeBySession(sessionId: string): Promise<LocalTokenUsageSummary>;
  summarizeByAgent(
    agentName: string,
    opts?: { from?: number; to?: number },
  ): Promise<LocalTokenUsageSummary>;
  summarizeGlobal(opts?: { from?: number; to?: number }): Promise<LocalTokenUsageSummary>;
  summarizeGroupBy(
    groupBy: LocalTokenUsageGroupBy,
    opts?: { from?: number; to?: number; agentName?: string; sessionId?: string },
  ): Promise<Array<{ key: string; summary: LocalTokenUsageSummary }>>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface LocalFileDiff {
  file: string;
  additions: number;
  deletions: number;
  status?: string;
  diff?: string;
  patch?: {
    oldFileName: string;
    newFileName: string;
    hunks: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
    }>;
  };
  external?: boolean;
}

export interface LocalTurnDiffSnapshotEntry {
  file: string;
  exists: boolean;
  hash?: string;
  sizeBytes?: number;
  content?: string;
  binary?: boolean;
  oversized?: boolean;
}

export interface LocalTurnDiffUndoEntry {
  file: string;
  before: LocalTurnDiffSnapshotEntry;
  after: LocalTurnDiffSnapshotEntry;
}

export type LocalTurnDiffToolCaptureStatus = 'started' | 'completed' | 'ambiguous' | 'failed';
export type LocalTurnDiffTurnStatus = 'pending' | 'finalized' | 'empty' | 'failed' | 'superseded';

export interface LocalTurnDiffToolCapture {
  captureId: string;
  turnId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  sequence: number;
  paths: string[];
  before: LocalTurnDiffSnapshotEntry[];
  after: LocalTurnDiffSnapshotEntry[];
  status: LocalTurnDiffToolCaptureStatus;
  ambiguityReason?: string;
  createdAtMs: number;
  completedAtMs?: number;
}

export interface LocalTurnDiffTurn {
  turnId: string;
  sessionId: string;
  agentName: string;
  workspaceDir: string;
  createdAtMs: number;
  finalizedAtMs?: number;
  status: LocalTurnDiffTurnStatus;
}

export interface LocalTurnDiffRecord {
  changeSetId: string;
  sessionId: string;
  agentName?: string;
  turnId: string;
  assistantMessageId?: string;
  workspaceDir: string;
  capturedAtMs: number;
  updatedAtMs?: number;
  status: 'active' | 'reverted';
  fileChanges: LocalFileDiff[];
  undo?: LocalTurnDiffUndoEntry[];
  undoable?: boolean;
  rawDiff?: string;
  revertedAt?: number;
}

export interface LocalTurnDiffRewindFilePlan {
  readonly workspaceDir: string;
  readonly file: string;
  readonly expected: LocalTurnDiffSnapshotEntry;
  readonly target: LocalTurnDiffSnapshotEntry;
  /** Turns represented by this final merged file write, newest first. */
  readonly turnIds?: readonly string[];
}

export interface LocalTurnDiffRewindPlan {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly sessionId: string;
  readonly requestedTurnIds: readonly string[];
  readonly turnIds: readonly string[];
  readonly changeSetIds: readonly string[];
  readonly files: readonly LocalTurnDiffRewindFilePlan[];
  /** Turns whose recorded files could not be proven safe while planning. */
  readonly skippedTurnIds?: readonly string[];
}

export type LocalTurnDiffRewindReceipt =
  | { readonly status: 'no-diff' }
  | { readonly status: 'rewound'; readonly revertedTurnIds: readonly string[] }
  | {
      readonly status: 'failed-after-rewind';
      readonly revertedTurnIds: readonly string[];
      readonly errorCode: 'conflict' | 'io-failed';
    };

export interface LocalTurnDiffRewindOperation {
  readonly plan: LocalTurnDiffRewindPlan;
  readonly receipt?: LocalTurnDiffRewindReceipt;
}

export interface LocalTurnDiffStore {
  createTurn(input: {
    turnId: string;
    sessionId: string;
    agentName: string;
    workspaceDir: string;
  }): Promise<void>;
  getPendingTurn(sessionId: string): Promise<LocalTurnDiffTurn | undefined>;
  createToolCapture(input: {
    captureId: string;
    turnId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    paths: string[];
    before: LocalTurnDiffSnapshotEntry[];
  }): Promise<boolean>;
  completeToolCapture(input: {
    turnId: string;
    sessionId: string;
    toolCallId: string;
    after: LocalTurnDiffSnapshotEntry[];
  }): Promise<boolean>;
  markToolCaptureAmbiguous(input: {
    captureId: string;
    turnId: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    paths?: string[];
    before?: LocalTurnDiffSnapshotEntry[];
    reason: string;
  }): Promise<void>;
  getStartedToolCapture(
    turnId: string,
    sessionId: string,
    toolCallId: string,
  ): Promise<LocalTurnDiffToolCapture | undefined>;
  listCompletedToolCaptures(sessionId: string, turnId: string): Promise<LocalTurnDiffToolCapture[]>;
  markTurnFinalized(
    sessionId: string,
    turnId: string,
    status: LocalTurnDiffTurnStatus,
  ): Promise<void>;
  markOtherPendingTurnsFinalized(
    sessionId: string,
    keepTurnId: string,
    status: LocalTurnDiffTurnStatus,
  ): Promise<void>;
  upsert(record: LocalTurnDiffRecord): Promise<void>;
  getByTurn(sessionId: string, turnId: string): Promise<LocalTurnDiffRecord | undefined>;
  getByAssistantMessage(
    sessionId: string,
    assistantMessageId: string,
  ): Promise<LocalTurnDiffRecord | undefined>;
  getByChangeSetId(
    sessionId: string,
    changeSetId: string,
  ): Promise<LocalTurnDiffRecord | undefined>;
  latestForSession(sessionId: string): Promise<LocalTurnDiffRecord | undefined>;
  listBySession(sessionId: string): Promise<LocalTurnDiffRecord[]>;
  updateStatus(
    sessionId: string,
    changeSetId: string,
    status: 'active' | 'reverted',
    revertedAt?: number,
  ): Promise<LocalTurnDiffRecord | undefined>;
  getRewindOperation(operationId: string): Promise<LocalTurnDiffRewindOperation | undefined>;
  putRewindPlan(plan: LocalTurnDiffRewindPlan): Promise<void>;
  putRewindReceipt(operationId: string, receipt: LocalTurnDiffRewindReceipt): Promise<void>;
  deleteTurns(sessionId: string, turnIds: readonly string[]): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export type LocalCommunicationMessageStatus = 'delivered' | 'failed';

export interface LocalCommunicationMessageRecord {
  messageId: string;
  fromSession: string;
  toSession: string;
  command: string;
  content: string;
  status: LocalCommunicationMessageStatus;
  error?: string;
  createdAtMs: number;
}

export interface LocalCommunicationMessageStore {
  append(record: LocalCommunicationMessageRecord): Promise<void>;
  list(opts?: {
    fromSession?: string;
    toSession?: string;
    status?: LocalCommunicationMessageStatus;
    limit?: number;
  }): Promise<LocalCommunicationMessageRecord[]>;
  deleteSession(sessionId: string): Promise<void>;
}
