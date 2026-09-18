import {
  THREAD_GOAL_STATUSES,
  THREAD_GOAL_STATUS_REASONS,
  THREAD_GOAL_WAIT_REASONS,
  type LastVerificationV1,
  type LastWorkerProposalV1,
  type ThreadGoalAttachment,
  type ThreadGoalExecutionWait,
  type ThreadGoalKickoffState,
  type ThreadGoalState,
  type ThreadGoalStatus,
  type ThreadGoalStatusReason,
  type ThreadGoalWaitReason,
} from '@mavis/goal';

import { logger } from '../common/logger.js';
import { THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS } from './store-worker-proposal.js';

export interface ThreadGoalDbRow {
  goal_id?: string;
  session_id?: string;
  objective?: string;
  status?: string;
  created_at_ms?: number;
  updated_at_ms?: number;
  tokens_used?: number;
  time_used_seconds?: number;
  token_budget?: number | null;
  kickoff_attachments_json?: string;
  objective_resources_json?: string;
  kickoff_state?: string;
  turns_used?: number;
  reply_fingerprint?: string | null;
  no_progress_streak?: number;
  no_tool_streak?: number;
  last_verification?: string | null;
  last_worker_proposal?: string | null;
  status_reason?: string | null;
  execution_wait_reason?: string | null;
  execution_wait_since_ms?: number | null;
  execution_wait_epoch?: number | null;
}

const STATUS_SET = new Set<string>(THREAD_GOAL_STATUSES);
const STATUS_REASON_SET = new Set<string>(THREAD_GOAL_STATUS_REASONS);
const WAIT_REASON_SET = new Set<string>(THREAD_GOAL_WAIT_REASONS);

export function rowToThreadGoalState(
  row: ThreadGoalDbRow | undefined,
): ThreadGoalState | undefined {
  if (!row || !row.goal_id || !row.session_id || !row.objective || !row.status) return undefined;
  const status = readStatus(row.status, row.goal_id);
  return {
    goalId: row.goal_id,
    sessionId: row.session_id,
    objective: row.objective,
    objectiveResources: readKickoffAttachments(row.objective_resources_json),
    status,
    createdAt: row.created_at_ms ?? 0,
    updatedAt: row.updated_at_ms ?? 0,
    // Migration 14 backfills these to 0; a legacy row with a `null`
    // coming from a partial / failed migration would still surface as
    // 0 here so the banner doesn't show NaN.
    tokensUsed: numericOrZero(row.tokens_used),
    turnsUsed: numericOrZero(row.turns_used),
    timeUsedSeconds: numericOrZero(row.time_used_seconds),
    // Migration 15 adds `token_budget` as a nullable INTEGER. NULL or
    // any non-positive value collapses to `null` (= "no cap") so the
    // banner never displays an absurd `0 / 0` denominator.
    tokenBudget: positiveOrNull(row.token_budget),
    replyFingerprint: typeof row.reply_fingerprint === 'string' ? row.reply_fingerprint : null,
    noProgressStreak: numericOrZero(row.no_progress_streak),
    noToolStreak: numericOrZero(row.no_tool_streak),
    lastVerification: readLastVerification(row.last_verification, row.goal_id),
    lastWorkerProposal: readLastWorkerProposal(row.last_worker_proposal, row.goal_id),
    statusReason: readStatusReason(row.status_reason, row.goal_id),
    kickoffAttachments: readKickoffAttachments(row.kickoff_attachments_json),
    kickoffState: readKickoffState(row.kickoff_state),
    // A wait is only meaningful for an `active` Goal, and only for the exact
    // admission epoch it was decided against. Guarding on both here is what
    // lets every other writer ignore these columns: advancing `updated_at_ms`
    // retires the wait automatically, so a paused -> active transition (or any
    // future epoch writer) can never revive a previous epoch's reason.
    executionWait:
      status === 'active' && row.execution_wait_epoch === (row.updated_at_ms ?? 0)
        ? readExecutionWait(row.execution_wait_reason, row.execution_wait_since_ms, row.goal_id)
        : null,
  };
}

export function isKnownThreadGoalStatus(value: string | undefined): boolean {
  return value !== undefined && STATUS_SET.has(value);
}

function readStatus(value: string, goalId: string): ThreadGoalStatus {
  if (STATUS_SET.has(value)) return value as ThreadGoalStatus;
  logger.warn(
    { goalId, persistedStatus: value },
    'Unknown thread Goal status read fail-closed as paused',
  );
  return 'paused';
}

function readStatusReason(
  value: string | null | undefined,
  goalId: string,
): ThreadGoalStatusReason | null {
  if (value == null) return null;
  if (STATUS_REASON_SET.has(value)) return value as ThreadGoalStatusReason;
  logger.warn(
    { goalId, persistedStatusReason: value },
    'Unknown thread Goal status reason ignored',
  );
  return null;
}

/**
 * Read the persisted wait projection. An unrecognized reason is dropped rather
 * than surfaced, matching `readStatusReason`: an older client seeing a reason
 * minted by a newer runtime degrades to today's behaviour instead of rendering
 * a raw enum string.
 */
function readExecutionWait(
  reason: string | null | undefined,
  sinceMs: number | null | undefined,
  goalId: string,
): ThreadGoalExecutionWait | null {
  if (reason == null) return null;
  if (!WAIT_REASON_SET.has(reason)) {
    logger.warn({ goalId, persistedWaitReason: reason }, 'Unknown thread Goal wait reason ignored');
    return null;
  }
  if (typeof sinceMs !== 'number' || !Number.isSafeInteger(sinceMs) || sinceMs < 0) {
    logger.warn({ goalId, persistedWaitSinceMs: sinceMs }, 'Invalid thread Goal wait time ignored');
    return null;
  }
  return { reason: reason as ThreadGoalWaitReason, sinceMs };
}

function readLastVerification(
  value: string | null | undefined,
  goalId: string,
): LastVerificationV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isLastVerificationV1(parsed)) return undefined;
    return {
      v: 1,
      backend: parsed.backend,
      verdict: parsed.verdict,
      reason: parsed.reason,
      missing: [...parsed.missing],
      ...(parsed.missingFingerprint ? { missingFingerprint: parsed.missingFingerprint } : {}),
      notMetStreak: parsed.notMetStreak,
      turnId: parsed.turnId,
      objectiveDigest: parsed.objectiveDigest,
      at: parsed.at,
    };
  } catch (error) {
    logger.warn({ goalId, error }, 'Invalid thread Goal verification JSON ignored');
    return undefined;
  }
}

function isLastVerificationV1(value: unknown): value is LastVerificationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.v === 1 &&
    (item.backend === 'evaluator' || item.backend === 'subagent') &&
    (item.verdict === 'met' ||
      item.verdict === 'not_met' ||
      item.verdict === 'impossible' ||
      item.verdict === 'inconclusive') &&
    typeof item.reason === 'string' &&
    Array.isArray(item.missing) &&
    item.missing.every((entry) => typeof entry === 'string') &&
    optionalString(item.missingFingerprint) &&
    Number.isInteger(item.notMetStreak) &&
    (item.notMetStreak as number) >= 0 &&
    typeof item.turnId === 'string' &&
    typeof item.objectiveDigest === 'string' &&
    Number.isInteger(item.at) &&
    (item.at as number) >= 0
  );
}

function readLastWorkerProposal(
  value: string | null | undefined,
  goalId: string,
): LastWorkerProposalV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isLastWorkerProposalV1(parsed)) return undefined;
    return {
      v: 1,
      source: 'worker',
      type: parsed.type,
      turnId: parsed.turnId,
      ...(parsed.summary ? { summary: parsed.summary } : {}),
      at: parsed.at,
    };
  } catch (error) {
    logger.warn({ goalId, error }, 'Invalid thread Goal worker proposal JSON ignored');
    return undefined;
  }
}

function isLastWorkerProposalV1(value: unknown): value is LastWorkerProposalV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.v === 1 &&
    item.source === 'worker' &&
    (item.type === 'complete' || item.type === 'blocked') &&
    typeof item.turnId === 'string' &&
    optionalString(item.summary) &&
    (typeof item.summary !== 'string' ||
      item.summary.length <= THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS) &&
    Number.isInteger(item.at) &&
    (item.at as number) >= 0
  );
}

function readKickoffState(value: string | undefined): ThreadGoalKickoffState {
  if (value === 'pending' || value === 'enqueued' || value === 'consumed') return value;
  return 'consumed';
}

function readKickoffAttachments(value: string | undefined): ThreadGoalAttachment[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) => {
      if (!isKickoffAttachment(candidate)) return [];
      return [{ ...candidate }];
    });
  } catch {
    return [];
  }
}

function isKickoffAttachment(value: unknown): value is ThreadGoalAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    (item.type === 'file' || item.type === 'image') &&
    typeof item.filePath === 'string' &&
    typeof item.fileName === 'string' &&
    typeof item.mimeType === 'string' &&
    optionalString(item.dataUrl) &&
    optionalString(item.assetId) &&
    optionalString(item.error)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

export function numericOrZero(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** Coerce an invalid or absent token budget to the canonical uncapped value. */
export function positiveOrNull(value: number | undefined | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

/** Generate the short opaque id used by local Thread Goals. */
export function newThreadGoalId(): string {
  return `tg_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}
