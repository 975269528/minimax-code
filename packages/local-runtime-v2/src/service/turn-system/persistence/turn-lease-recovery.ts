import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';

import { sessionLocks, turnIngress } from '../../../infra/db/schema/turn.js';
import type {
  ProcessRestartOwnerKind,
  ProcessRestartRecoveryEntry,
  TurnRecoveryTerminalFact,
  TurnRepositoryOptions,
} from './contracts.js';

export const SESSION_DELETION_OWNER_KIND = 'session-deletion';
export const MAINTENANCE_OWNER_KIND = 'maintenance';
export const MAINTENANCE_DELETING_OWNER_KIND = 'maintenance-deleting';
export const TURN_DELETING_OWNER_KIND = 'turn-deleting';
export const COMPACTION_DELETING_OWNER_KIND = 'compaction-deleting';
export const DELETION_FENCE_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;

const PROCESS_RESTART_OWNER_KINDS: readonly ProcessRestartOwnerKind[] = [
  'turn',
  'compaction',
  'send',
  'dispatcher',
  MAINTENANCE_OWNER_KIND,
  TURN_DELETING_OWNER_KIND,
  COMPACTION_DELETING_OWNER_KIND,
  MAINTENANCE_DELETING_OWNER_KIND,
  SESSION_DELETION_OWNER_KIND,
];

type TurnLeaseRecoveryTransaction = Parameters<
  Parameters<TurnRepositoryOptions['db']['transaction']>[0]
>[0];

interface TurnLeaseRecoveryResult {
  readonly released: boolean;
  readonly terminalFacts: readonly TurnRecoveryTerminalFact[];
}

export interface TurnProcessRestartRecoveryInput {
  readonly processStartedAtMs: number;
  readonly completedAtMs: number;
  readonly isLeaseOwnerAlive: (ownerId: string) => boolean | undefined;
  readonly makeDeletionOwnerId: () => string;
  readonly shouldRecoverLegacyTurnLease?: (input: {
    readonly sessionId: string;
    readonly ownerId: string;
    readonly ownerKind: string;
    readonly acquiredAtMs: number;
    readonly expiresAtMs: number;
    readonly observedAtMs: number;
  }) => boolean;
}

interface TurnProcessRestartRecoveryResult {
  readonly recovered: ProcessRestartRecoveryEntry[];
  readonly liveSessionIds: string[];
  readonly pendingDeletionSessionIds: string[];
  readonly terminalFacts: readonly TurnRecoveryTerminalFact[];
}

export function recoverExpiredInTransaction(
  tx: TurnLeaseRecoveryTransaction,
  sessionId: string,
  nowMs: number,
): TurnLeaseRecoveryResult {
  const expired = tx
    .select()
    .from(sessionLocks)
    .where(and(eq(sessionLocks.sessionId, sessionId), lte(sessionLocks.expiresAtMs, nowMs)))
    .get();
  if (!expired) return { released: false, terminalFacts: [] };
  return releaseRecoveredLockInTransaction(tx, expired, nowMs, 'expired-lease');
}

export function recoverDeadLegacyOwnerInTransaction(
  tx: TurnLeaseRecoveryTransaction,
  sessionId: string,
  nowMs: number,
): TurnLeaseRecoveryResult {
  const lock = findSessionLock(tx, sessionId);
  if (!lock || legacyProcessOwnerAlive(lock) !== false) {
    return { released: false, terminalFacts: [] };
  }
  return releaseRecoveredLockInTransaction(tx, lock, nowMs, 'process-restart');
}

export function recoverProcessRestartInTransaction(
  tx: TurnLeaseRecoveryTransaction,
  input: TurnProcessRestartRecoveryInput,
): TurnProcessRestartRecoveryResult {
  const {
    processStartedAtMs,
    completedAtMs,
    isLeaseOwnerAlive,
    makeDeletionOwnerId,
    shouldRecoverLegacyTurnLease,
  } = input;
  const orphanedLocks = tx
    .select()
    .from(sessionLocks)
    .where(
      and(
        inArray(sessionLocks.ownerKind, [...PROCESS_RESTART_OWNER_KINDS]),
        lt(sessionLocks.acquiredAtMs, processStartedAtMs),
      ),
    )
    .orderBy(asc(sessionLocks.sessionId))
    .all();
  const recovered: ProcessRestartRecoveryEntry[] = [];
  const liveSessionIds: string[] = [];
  const pendingDeletionSessionIds: string[] = [];
  for (const lock of orphanedLocks) {
    const ownerAlive = isLeaseOwnerAlive(lock.ownerId);
    const recoverStalledLegacyLease =
      ownerAlive === undefined &&
      lock.expiresAtMs > completedAtMs &&
      shouldRecoverLegacyTurnLease?.({
        sessionId: lock.sessionId,
        ownerId: lock.ownerId,
        ownerKind: lock.ownerKind,
        acquiredAtMs: lock.acquiredAtMs,
        expiresAtMs: lock.expiresAtMs,
        observedAtMs: completedAtMs,
      }) === true;
    if (
      ownerAlive === true ||
      (ownerAlive === undefined && lock.expiresAtMs > completedAtMs && !recoverStalledLegacyLease)
    ) {
      liveSessionIds.push(lock.sessionId);
      continue;
    }
    if (lock.ownerKind === SESSION_DELETION_OWNER_KIND) {
      const reclaimed = tx
        .update(sessionLocks)
        .set({
          ownerId: makeDeletionOwnerId(),
          acquiredAtMs: completedAtMs,
          expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
        })
        .where(
          and(
            eq(sessionLocks.sessionId, lock.sessionId),
            eq(sessionLocks.ownerId, lock.ownerId),
            eq(sessionLocks.ownerKind, lock.ownerKind),
            eq(sessionLocks.acquiredAtMs, lock.acquiredAtMs),
          ),
        )
        .run();
      if (reclaimed.changes !== 1) {
        throw new Error(`Session deletion recovery lost ownership: ${lock.sessionId}`);
      }
      pendingDeletionSessionIds.push(lock.sessionId);
      continue;
    }
    recovered.push(recoverProcessRestartLockInTransaction(tx, lock, completedAtMs));
  }
  return {
    recovered,
    liveSessionIds,
    pendingDeletionSessionIds,
    terminalFacts: recovered.flatMap((entry) =>
      entry.turnId
        ? [
            createRecoveredTerminalFact(
              entry.sessionId,
              entry.turnId,
              completedAtMs,
              'process-restart',
            ),
          ]
        : [],
    ),
  };
}

export function createRecoveredTerminalFact(
  sessionId: string,
  turnId: string,
  completedAtMs: number,
  reason: TurnRecoveryTerminalFact['reason'],
): TurnRecoveryTerminalFact {
  return {
    sessionId,
    turnId,
    completedAtMs,
    outcome: 'failed',
    reason,
  };
}

function releaseRecoveredLockInTransaction(
  tx: TurnLeaseRecoveryTransaction,
  lock: typeof sessionLocks.$inferSelect,
  completedAtMs: number,
  reason: TurnRecoveryTerminalFact['reason'],
): TurnLeaseRecoveryResult & { readonly released: true } {
  const orphan = tx
    .select({ turnId: turnIngress.turnId })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, lock.sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .get();
  const terminalFacts: readonly TurnRecoveryTerminalFact[] = orphan
    ? [createRecoveredTerminalFact(lock.sessionId, orphan.turnId, completedAtMs, reason)]
    : [];
  if (orphan) {
    tx.update(turnIngress)
      .set({ status: 'failed', completedAtMs })
      .where(eq(turnIngress.turnId, orphan.turnId))
      .run();
  }
  tx.delete(sessionLocks)
    .where(
      and(
        eq(sessionLocks.sessionId, lock.sessionId),
        eq(sessionLocks.ownerId, lock.ownerId),
        eq(sessionLocks.ownerKind, lock.ownerKind),
      ),
    )
    .run();
  return { released: true, terminalFacts };
}

function legacyProcessOwnerAlive(lock: typeof sessionLocks.$inferSelect): boolean | undefined {
  const match = /^(electron|cli|runtime):([1-9]\d*):.+$/.exec(lock.ownerId);
  if (!match || match[1] !== lock.ownerKind) return undefined;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid)) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) return undefined;
    if (error.code === 'EPERM') return true;
    return error.code === 'ESRCH' ? false : undefined;
  }
}

function findSessionLock(tx: TurnLeaseRecoveryTransaction, sessionId: string) {
  return tx.select().from(sessionLocks).where(eq(sessionLocks.sessionId, sessionId)).get();
}

function recoverProcessRestartLockInTransaction(
  tx: TurnLeaseRecoveryTransaction,
  lock: typeof sessionLocks.$inferSelect,
  completedAtMs: number,
): ProcessRestartRecoveryEntry {
  const ownerKind = lock.ownerKind as ProcessRestartOwnerKind;
  const turnId = isTurnOwnerKind(ownerKind)
    ? failLatestAcceptedTurnInTransaction(tx, lock.sessionId, completedAtMs)
    : undefined;
  const released = tx
    .delete(sessionLocks)
    .where(
      and(
        eq(sessionLocks.sessionId, lock.sessionId),
        eq(sessionLocks.ownerId, lock.ownerId),
        eq(sessionLocks.ownerKind, lock.ownerKind),
        eq(sessionLocks.acquiredAtMs, lock.acquiredAtMs),
      ),
    )
    .run();
  if (released.changes !== 1) {
    throw new Error(`Process restart recovery lost ownership: ${lock.sessionId}/${lock.ownerId}`);
  }
  return restartRecoveryEntry(lock.sessionId, ownerKind, turnId);
}

function failLatestAcceptedTurnInTransaction(
  tx: TurnLeaseRecoveryTransaction,
  sessionId: string,
  completedAtMs: number,
): string | undefined {
  const orphan = tx
    .select({ turnId: turnIngress.turnId })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .get();
  if (!orphan) return undefined;
  const updated = tx
    .update(turnIngress)
    .set({ status: 'failed', completedAtMs })
    .where(and(eq(turnIngress.turnId, orphan.turnId), eq(turnIngress.status, 'accepted')))
    .run();
  if (updated.changes !== 1) {
    throw new Error(`Process restart Turn recovery lost ownership: ${sessionId}/${orphan.turnId}`);
  }
  return orphan.turnId;
}

function restartRecoveryEntry(
  sessionId: string,
  ownerKind: ProcessRestartOwnerKind,
  turnId?: string,
): ProcessRestartRecoveryEntry {
  return {
    sessionId,
    ownerKind,
    ...(turnId ? { turnId } : {}),
    disposition: 'released',
  };
}

function isTurnOwnerKind(ownerKind: ProcessRestartOwnerKind): boolean {
  return (
    ownerKind === 'turn' ||
    ownerKind === 'compaction' ||
    ownerKind === 'send' ||
    ownerKind === 'dispatcher' ||
    isDeletingTurnOwnerKind(ownerKind)
  );
}

function isDeletingTurnOwnerKind(ownerKind: ProcessRestartOwnerKind): boolean {
  return ownerKind === TURN_DELETING_OWNER_KIND || ownerKind === COMPACTION_DELETING_OWNER_KIND;
}
