import * as cleanup from './cleanup-settlement.js';
import type {
  MiniAppPersistedState,
  MiniAppStateStore,
  PreparedMiniAppStopTransition,
  PreparedMiniAppTransition,
} from '../contracts.js';
import * as errors from '../errors.js';
import { MiniAppError } from '../errors.js';
import type { MiniAppGeneration } from './supervisor-generation.js';

const EXPLICIT_START_REQUIRED_FIELD = 'requiresExplicitStart';

export interface PublicationMemorySnapshot {
  readonly disabled: boolean;
  readonly cold: boolean;
  readonly quarantined: boolean;
  readonly failureCode: string | undefined;
  readonly explicitlyStopped: boolean;
}

export interface SupervisorPreparation {
  readonly controller: AbortController;
  readonly unlinkSignal: () => void;
  promise: Promise<PreparedMiniAppTransition | PreparedMiniAppStopTransition>;
}

export function createSupervisorPreparation(
  signal: AbortSignal | undefined,
): SupervisorPreparation {
  const controller = new AbortController();
  if (!signal) {
    return {
      controller,
      unlinkSignal: () => undefined,
      promise: Promise.resolve(undefined as never),
    };
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return {
    controller,
    unlinkSignal: () => signal.removeEventListener('abort', abort),
    promise: Promise.resolve(undefined as never),
  };
}

export interface PublicationMemoryCollections {
  readonly disabled: Set<string>;
  readonly cold: Set<string>;
  readonly quarantined: Set<string>;
  readonly failures: Map<string, string>;
  readonly explicitlyStopped: Set<string>;
}

export function disablePreparationCancellation(): MiniAppError {
  return new MiniAppError('DISABLED', 'Mini App was disabled during preparation');
}

export function disableRolledBackError(): MiniAppError {
  return new MiniAppError('SUPERSEDED', 'Mini App disable was rolled back');
}

export function restorePublicationPersistence(input: {
  readonly stateStore: MiniAppStateStore;
  readonly pluginId: string;
  readonly previous: MiniAppPersistedState | undefined;
  readonly onFailure: (failure: MiniAppError) => void;
}): void {
  cleanup.restoreRuntimePersistence({
    previous: input.previous,
    write: (state) => input.stateStore.write(state),
    remove: () => input.stateStore.remove(input.pluginId),
    onFailure: input.onFailure,
  });
}

export function capturePublicationMemory(
  collections: PublicationMemoryCollections,
  pluginId: string,
): PublicationMemorySnapshot {
  return {
    disabled: collections.disabled.has(pluginId),
    cold: collections.cold.has(pluginId),
    quarantined: collections.quarantined.has(pluginId),
    failureCode: collections.failures.get(pluginId),
    explicitlyStopped: collections.explicitlyStopped.has(pluginId),
  };
}

export function restorePublicationMemory(
  collections: PublicationMemoryCollections,
  pluginId: string,
  snapshot: PublicationMemorySnapshot,
): void {
  restoreSetMembership(collections.disabled, pluginId, snapshot.disabled);
  restoreSetMembership(collections.cold, pluginId, snapshot.cold);
  restoreSetMembership(collections.quarantined, pluginId, snapshot.quarantined);
  restoreMapValue(collections.failures, pluginId, snapshot.failureCode);
  restoreSetMembership(collections.explicitlyStopped, pluginId, snapshot.explicitlyStopped);
}

export function persistedErrorDetail(value: string | undefined): {
  readonly code?: string;
  readonly requiresExplicitStart: boolean;
} {
  if (!value) return { requiresExplicitStart: false };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { requiresExplicitStart: false };
    }
    const detail = parsed as Record<string, unknown>;
    return {
      ...(typeof detail.code === 'string' ? { code: detail.code } : {}),
      requiresExplicitStart: detail[EXPLICIT_START_REQUIRED_FIELD] === true,
    };
  } catch {
    return { requiresExplicitStart: false };
  }
}

export function explicitStartRequiredJson(previous: string | undefined, code?: string): string {
  const nextCode = code ?? persistedErrorDetail(previous).code;
  return JSON.stringify({
    ...(nextCode ? { code: nextCode } : {}),
    [EXPLICIT_START_REQUIRED_FIELD]: true,
  });
}

export function persistExplicitStartFence(
  stateStore: MiniAppStateStore,
  pluginId: string,
  nowMs: number,
): void {
  try {
    const state = stateStore.read(pluginId);
    if (!state) throw new Error('Mini App accepted state is missing');
    stateStore.write({
      ...state,
      lastErrorJson: explicitStartRequiredJson(state.lastErrorJson),
      updatedAtMs: Math.max(nowMs, state.updatedAtMs),
    });
  } catch (cause) {
    throw new MiniAppError(
      'PERSISTENCE_WRITE_FAILED',
      'Mini App explicit-start fence could not be persisted',
      { cause },
    );
  }
}

export async function rollbackCommittedGeneration(input: {
  readonly pluginId: string;
  readonly active: Map<string, MiniAppGeneration>;
  readonly retiring: Map<string, MiniAppGeneration[]>;
  readonly committedGeneration: MiniAppGeneration;
  readonly previousGeneration: MiniAppGeneration | undefined;
  readonly previousAccepting: boolean;
  readonly persistenceCompensation: () => void;
  readonly restoreMemory: () => void;
  readonly reusableGeneration: MiniAppGeneration | undefined;
  readonly runtimeWasReused: boolean;
  readonly cleanupRuntime: (runtime: MiniAppGeneration['runtime']) => Promise<void>;
}): Promise<void> {
  if (input.active.get(input.pluginId) !== input.committedGeneration) {
    throw new MiniAppError('SUPERSEDED', 'Mini App generation changed before publication rollback');
  }
  if (input.committedGeneration.leases.size !== 0) {
    throw new MiniAppError(
      'SUPERSEDED',
      'Mini App generation leases must be released before publication rollback',
    );
  }
  input.committedGeneration.accepting = false;
  input.committedGeneration.idleTimer?.cancel();
  input.committedGeneration.idleTimer = undefined;
  if (input.previousGeneration) {
    removeRetiringGeneration(input.retiring, input.pluginId, input.previousGeneration);
    input.previousGeneration.accepting = input.previousAccepting;
    input.active.set(input.pluginId, input.previousGeneration);
  } else {
    input.active.delete(input.pluginId);
  }
  if (
    input.previousGeneration &&
    input.previousGeneration === input.reusableGeneration &&
    input.runtimeWasReused
  ) {
    input.previousGeneration.runtime = input.committedGeneration.runtime;
  }
  input.restoreMemory();
  const persistence = await cleanup.captureOperation(input.persistenceCompensation);
  const runtimeCleanup = await cleanup.captureOperation(() =>
    input.cleanupRuntime(input.runtimeWasReused ? undefined : input.committedGeneration.runtime),
  );
  errors.assertMiniAppCleanupsProven([runtimeCleanup]);
  if (persistence.status === 'rejected') throw persistence.reason;
  if (runtimeCleanup.status === 'rejected') throw runtimeCleanup.reason;
}

export function removeRetiringGeneration(
  retiring: Map<string, MiniAppGeneration[]>,
  pluginId: string,
  generation: MiniAppGeneration,
): void {
  generation.retirementPendingFinalization = false;
  const remaining = (retiring.get(pluginId) ?? []).filter((entry) => entry !== generation);
  if (remaining.length === 0) retiring.delete(pluginId);
  else retiring.set(pluginId, remaining);
}

function restoreSetMembership(set: Set<string>, value: string, present: boolean): void {
  if (present) set.add(value);
  else set.delete(value);
}

function restoreMapValue<T>(map: Map<string, T>, key: string, value: T | undefined): void {
  if (value === undefined) map.delete(key);
  else map.set(key, value);
}
