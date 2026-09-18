import { and, eq } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { sessions } from '../../../infra/db/schema/sessions.js';

export interface SessionMemoryPolicy {
  readonly recallEnabled: boolean;
  readonly writeEnabled: boolean;
  readonly recallLocked: boolean;
  readonly recallLockedAtMs?: number;
}

export type SessionMemoryPolicyPatch = Partial<
  Pick<SessionMemoryPolicy, 'recallEnabled' | 'writeEnabled'>
>;

export const DEFAULT_SESSION_MEMORY_POLICY: SessionMemoryPolicy = {
  recallEnabled: true,
  writeEnabled: true,
  recallLocked: false,
};

export function effectiveSessionMemoryPolicy(
  policy: SessionMemoryPolicy | undefined,
): SessionMemoryPolicy {
  return policy ?? DEFAULT_SESSION_MEMORY_POLICY;
}

export function applySessionMemoryPolicyPatch(
  current: SessionMemoryPolicy | undefined,
  patch: SessionMemoryPolicyPatch,
): SessionMemoryPolicy {
  return { ...effectiveSessionMemoryPolicy(current), ...patch };
}

export function readSessionMemoryPolicy(value: unknown, field: string): SessionMemoryPolicy {
  if (!isPlainObject(value)) throw new Error(`${field} must be an object`);
  const recallEnabled = requireBoolean(value.recallEnabled, `${field}.recallEnabled`);
  const writeEnabled = requireBoolean(value.writeEnabled, `${field}.writeEnabled`);
  const recallLocked = requireBoolean(value.recallLocked, `${field}.recallLocked`);
  const recallLockedAtMs = optionalSafeInteger(value.recallLockedAtMs, `${field}.recallLockedAtMs`);
  if (recallLocked && recallLockedAtMs === undefined) {
    throw new Error(`${field}.recallLockedAtMs is required when recall is locked`);
  }
  if (!recallLocked && recallLockedAtMs !== undefined) {
    throw new Error(`${field}.recallLockedAtMs requires recallLocked`);
  }
  return {
    recallEnabled,
    writeEnabled,
    recallLocked,
    ...(recallLockedAtMs === undefined ? {} : { recallLockedAtMs }),
  };
}

export function lockSessionMemoryRecallInTransaction(
  db: AppDb,
  input: { readonly sessionId: string; readonly lockedAtMs: number },
): 'locked' | 'already-locked' | 'not-found' {
  const row = db
    .select({ extraDataJson: sessions.extraDataJson })
    .from(sessions)
    .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3)))
    .get();
  if (!row) return 'not-found';
  const data = parseExtraDataEnvelope(row.extraDataJson);
  const current = effectiveSessionMemoryPolicy(
    data.memoryPolicy === undefined
      ? undefined
      : readSessionMemoryPolicy(data.memoryPolicy, 'extra_data_json.memoryPolicy'),
  );
  if (current.recallLocked) return 'already-locked';
  const next = {
    ...data,
    memoryPolicy: {
      ...current,
      recallLocked: true,
      recallLockedAtMs: input.lockedAtMs,
    },
  };
  db.update(sessions)
    .set({ extraDataJson: JSON.stringify(next), updatedAtMs: input.lockedAtMs })
    .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3)))
    .run();
  return 'locked';
}

function parseExtraDataEnvelope(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('extra_data_json is not valid JSON', { cause: error });
  }
  if (!isPlainObject(value)) throw new Error('extra_data_json must be an object');
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalSafeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
