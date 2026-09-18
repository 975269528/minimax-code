import type { AppDb } from '../../../infra/db/client.js';
import {
  compareAndSetSessionInteractionModeInTransaction,
  readSessionInteractionModeInTransaction,
  transitionSessionInteractionModeInTransaction,
  type EffectiveSessionInteractionMode,
} from './repo/drizzle.js';

export type SessionInteractionModeTransition =
  | 'updated'
  | 'already-plan'
  | 'already-goal'
  | 'already-default'
  | 'not-found'
  | 'conflict';

export interface SessionInteractionModeCapability {
  get(sessionId: string): Promise<EffectiveSessionInteractionMode | undefined>;
  setPlan(sessionId: string): Promise<SessionInteractionModeTransition>;
  setGoal(sessionId: string): Promise<SessionInteractionModeTransition>;
  ensureDefault(sessionId: string): Promise<SessionInteractionModeTransition>;
  readInTransaction(db: AppDb, sessionId: string): EffectiveSessionInteractionMode | undefined;
  compareAndSetInTransaction(
    db: AppDb,
    sessionId: string,
    expected: EffectiveSessionInteractionMode,
    next: EffectiveSessionInteractionMode,
  ): boolean;
  transitionInTransaction(
    db: AppDb,
    sessionId: string,
    expected: EffectiveSessionInteractionMode,
    next: EffectiveSessionInteractionMode,
  ): SessionInteractionModeTransition;
}

export interface CreateSessionInteractionModeCapabilityOptions {
  readonly db: AppDb;
  readonly nowMs?: () => number;
}

export function createSessionInteractionModeCapability(
  options: CreateSessionInteractionModeCapabilityOptions,
): SessionInteractionModeCapability {
  const nowMs = options.nowMs ?? Date.now;
  const readInTransaction = (db: AppDb, sessionId: string) =>
    readSessionInteractionModeInTransaction(db, sessionId);
  const compareAndSetInTransaction = (
    db: AppDb,
    sessionId: string,
    expected: EffectiveSessionInteractionMode,
    next: EffectiveSessionInteractionMode,
  ) =>
    compareAndSetSessionInteractionModeInTransaction(db, {
      sessionId,
      expected,
      next,
      updatedAtMs: nowMs(),
    });
  const transitionInTransaction = (
    db: AppDb,
    sessionId: string,
    expected: EffectiveSessionInteractionMode,
    next: EffectiveSessionInteractionMode,
  ) =>
    transitionSessionInteractionModeInTransaction(db, {
      sessionId,
      expected,
      next,
      updatedAtMs: nowMs(),
    });

  const transition = async (
    sessionId: string,
    expected: EffectiveSessionInteractionMode,
    next: EffectiveSessionInteractionMode,
  ): Promise<SessionInteractionModeTransition> =>
    options.db.transaction((tx) => transitionInTransaction(tx, sessionId, expected, next), {
      behavior: 'immediate',
    });

  return {
    get: async (sessionId) => readInTransaction(options.db, sessionId),
    setPlan: (sessionId) => transition(sessionId, 'default', 'plan'),
    setGoal: (sessionId) => transition(sessionId, 'default', 'goal'),
    ensureDefault: (sessionId) => transition(sessionId, 'plan', 'default'),
    readInTransaction,
    compareAndSetInTransaction,
    transitionInTransaction,
  };
}
