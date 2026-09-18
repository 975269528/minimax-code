import type {
  MiniAppNodeRuntime,
  PreparedMiniAppStopTransition,
  PreparedMiniAppTransition,
} from '../contracts.js';
import {
  assertMiniAppCleanupsProven,
  isMiniAppCleanupUnproven,
  MiniAppCleanupUnprovenError,
  MiniAppError,
} from '../errors.js';
import type { MiniAppGeneration } from './supervisor-generation.js';

export interface CleanupSettlement {
  readonly results: readonly PromiseSettledResult<unknown>[];
  readonly timeout?: MiniAppError;
}

export interface DisableCleanupSettlement {
  readonly proofResults: readonly PromiseSettledResult<unknown>[];
  readonly generationResults: readonly PromiseSettledResult<unknown>[];
  readonly timeouts: readonly MiniAppError[];
}

async function settleCleanupOperations(
  operations: readonly Promise<unknown>[],
  timeoutMs: number,
  timeoutMessage: string,
): Promise<CleanupSettlement> {
  const settlement = Promise.allSettled(operations);
  if (await settleWithin(settlement, timeoutMs)) return { results: await settlement };
  const timeout = new MiniAppCleanupUnprovenError(timeoutMessage, {
    cause: new Error('Mini App cleanup settlement timed out'),
  });
  return { results: [{ status: 'rejected', reason: timeout }], timeout };
}

export async function settleDisableCleanup(input: {
  readonly preparation: Promise<unknown>;
  readonly restart?: Promise<unknown>;
  readonly delegation?: Promise<unknown>;
  readonly startup?: Promise<unknown>;
  readonly cleanupGeneration?: () => Promise<unknown>;
  readonly timeoutMs: number;
}): Promise<DisableCleanupSettlement> {
  const lifecycle = await settleCleanupOperations(
    [
      input.preparation,
      ...(input.restart ? [input.restart] : []),
      ...(input.delegation ? [input.delegation] : []),
    ],
    input.timeoutMs,
    'Mini App lifecycle cleanup did not settle before disable',
  );
  const startup: CleanupSettlement = input.startup
    ? await settleCleanupOperations(
        [input.startup],
        input.timeoutMs,
        'Mini App startup cleanup did not settle before disable',
      )
    : { results: [] };
  const generationResults = input.cleanupGeneration
    ? await Promise.allSettled([input.cleanupGeneration()])
    : [];
  return {
    proofResults: [...lifecycle.results, ...startup.results],
    generationResults,
    timeouts: [lifecycle.timeout, startup.timeout].filter((error): error is MiniAppError =>
      Boolean(error),
    ),
  };
}

export async function captureOperation<T>(
  operation: () => T | PromiseLike<T>,
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await operation() };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

export function startOwnedOperation<T>(
  owner: { promise?: Promise<T>; observation?: Promise<void> },
  operation: () => Promise<T>,
): Promise<T> {
  let resolveOwned: (value: T) => void = () => undefined;
  let rejectOwned: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveOwned = resolve;
    rejectOwned = reject;
  });
  owner.promise = promise;
  owner.observation = settleOwnedOperation(operation, resolveOwned, rejectOwned);
  return promise;
}

async function settleOwnedOperation<T>(
  operation: () => Promise<T>,
  resolve: (value: T) => void,
  reject: (reason?: unknown) => void,
): Promise<void> {
  try {
    resolve(await operation());
  } catch (reason) {
    reject(reason);
  }
}

async function throwPrimaryAfterCleanup(
  primary: unknown,
  cleanupOperation: () => Promise<void>,
  compensationOperation?: () => void,
): Promise<never> {
  throw await selectFailureAfterCleanup(primary, cleanupOperation, compensationOperation);
}

export async function selectFailureAfterCleanup(
  primary: unknown,
  cleanupOperation: () => Promise<void>,
  compensationOperation?: () => void,
): Promise<unknown> {
  const compensationResult = compensationOperation
    ? await captureOperation(compensationOperation)
    : undefined;
  const cleanupResult = await captureOperation(cleanupOperation);
  if (cleanupResult.status === 'rejected' && isMiniAppCleanupUnproven(cleanupResult.reason)) {
    return cleanupResult.reason;
  }
  if (compensationResult?.status === 'rejected') return compensationResult.reason;
  return primary;
}

export async function acceptAndAdmitRuntime(input: {
  readonly accept: () => Promise<() => void>;
  readonly retirementOwners?: () => readonly { readonly retirementPromise?: Promise<void> }[];
  readonly isQuarantined?: () => boolean;
  readonly assertCurrent: () => void;
  readonly admit: () => void;
  readonly shouldCompensate: () => boolean;
  readonly cleanup: () => Promise<void>;
}): Promise<() => void> {
  const compensate = await input.accept();
  try {
    await settleRetirementOwners(input.retirementOwners?.() ?? []);
    if (input.isQuarantined?.()) {
      throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
    }
    input.assertCurrent();
    input.admit();
  } catch (primary) {
    await throwPrimaryAfterCleanup(
      primary,
      input.cleanup,
      input.shouldCompensate() ? compensate : undefined,
    );
  }
  return compensate;
}

export async function acceptRuntimePersistence<T>(input: {
  readonly quarantined: boolean;
  readonly readPrevious: () => T;
  readonly writeAccepted: (previous: T) => void;
  readonly restore: (previous: T) => void;
  readonly activate?: () => void;
  readonly cleanup: () => Promise<void>;
}): Promise<() => void> {
  if (input.quarantined) {
    await throwPrimaryAfterCleanup(
      new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven'),
      input.cleanup,
    );
  }
  let previous: T;
  let previousRead = false;
  try {
    previous = input.readPrevious();
    previousRead = true;
    input.writeAccepted(previous);
  } catch (cause) {
    await throwPrimaryAfterCleanup(
      new MiniAppError(
        'PERSISTENCE_WRITE_FAILED',
        'Mini App acceptance state could not be persisted',
        { cause },
      ),
      input.cleanup,
      previousRead ? () => input.restore(previous) : undefined,
    );
  }
  try {
    input.activate?.();
  } catch (cause) {
    await throwPrimaryAfterCleanup(
      new MiniAppError('ACTIVATION_FAILED', 'Mini App Host Connector activation failed', {
        cause,
      }),
      input.cleanup,
      () => input.restore(previous),
    );
  }
  let compensated = false;
  return () => {
    if (compensated) return;
    compensated = true;
    input.restore(previous);
  };
}

export function restoreRuntimePersistence<T>(input: {
  readonly previous: T | undefined;
  readonly write: (state: T) => void;
  readonly remove: () => void;
  readonly onFailure: (failure: MiniAppError) => void;
}): void {
  try {
    if (input.previous) input.write(input.previous);
    else input.remove();
  } catch (cause) {
    const failure = new MiniAppError(
      'PERSISTENCE_COMPENSATION_FAILED',
      'Mini App acceptance state could not be restored',
      { cause },
    );
    input.onFailure(failure);
    throw failure;
  }
}

async function settleRetirementOwners(
  owners: readonly { readonly retirementPromise?: Promise<void> }[],
): Promise<void> {
  await Promise.all(
    owners.flatMap((owner) => (owner.retirementPromise ? [owner.retirementPromise] : [])),
  );
}

export async function cleanupRuntime(runtime: MiniAppNodeRuntime | undefined): Promise<void> {
  if (!runtime) return;
  const result = await runtime.stop();
  if (!result.proven) {
    throw new MiniAppCleanupUnprovenError(
      'Mini App direct Node root termination could not be proven',
    );
  }
}

export async function collectRuntimeCleanupFailures(
  runtime: MiniAppNodeRuntime,
  terminalFailure?: unknown,
): Promise<readonly unknown[]> {
  const cleanupResult = await captureOperation(() => cleanupRuntime(runtime));
  return [
    ...(cleanupResult.status === 'rejected' ? [cleanupResult.reason] : []),
    ...(terminalFailure ? [terminalFailure] : []),
  ];
}

export async function settlePreparedTransitionCleanup(
  preparation: Promise<PreparedMiniAppTransition | PreparedMiniAppStopTransition>,
  timeoutMs: number,
): Promise<void> {
  const settlement = await settleCleanupOperations(
    [cleanupPreparedTransition(preparation)],
    timeoutMs,
    'Mini App preparation cleanup did not settle in time',
  );
  if (settlement.timeout) throw settlement.timeout;
  const [result] = settlement.results;
  if (result?.status === 'rejected') throw result.reason;
}

async function cleanupPreparedTransition(
  preparation: Promise<PreparedMiniAppTransition | PreparedMiniAppStopTransition>,
): Promise<void> {
  try {
    const transition = await preparation;
    await transition.rollback();
  } catch (error) {
    if (!isExpectedCancellation(error)) throw error;
  }
}

export function settleSupervisorClose(input: {
  readonly preparations: readonly {
    readonly pluginId: string;
    readonly promise: Promise<PreparedMiniAppTransition | PreparedMiniAppStopTransition>;
  }[];
  readonly generations: readonly MiniAppGeneration[];
  readonly timeoutMs: number;
  readonly onPreparationFailure: (pluginId: string, error: unknown) => void;
}): Promise<CleanupSettlement> {
  return settleCleanupOperations(
    [
      ...input.preparations.map(({ pluginId, promise }) =>
        cleanupClosePreparation(pluginId, promise, input.onPreparationFailure),
      ),
      ...input.generations.map(cleanupCloseGeneration),
    ],
    input.timeoutMs,
    'Mini App cleanup did not settle before close',
  );
}

async function cleanupClosePreparation(
  pluginId: string,
  preparation: Promise<PreparedMiniAppTransition | PreparedMiniAppStopTransition>,
  onFailure: (pluginId: string, error: unknown) => void,
): Promise<void> {
  try {
    await cleanupPreparedTransition(preparation);
  } catch (error) {
    onFailure(pluginId, error);
    throw error;
  }
}

async function cleanupCloseGeneration(generation: MiniAppGeneration): Promise<void> {
  const lifecycleResults = await Promise.allSettled(
    [generation.startPromise, generation.retirementPromise, generation.idleStopPromise].filter(
      (operation): operation is Promise<void> | Promise<MiniAppNodeRuntime> => Boolean(operation),
    ),
  );
  const runtimeCleanup = await captureOperation(() => cleanupRuntime(generation.runtime));
  const results = [...lifecycleResults, runtimeCleanup];
  assertMiniAppCleanupsProven(results);
  throwUnexpectedCleanupFailure(results);
}

function throwFirstRejected(results: readonly PromiseSettledResult<unknown>[]): void {
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}

export function throwUnexpectedCleanupFailure(
  results: readonly PromiseSettledResult<unknown>[],
): void {
  const failure = results.find(
    (result): result is PromiseRejectedResult =>
      result.status === 'rejected' && !isExpectedCancellation(result.reason),
  );
  if (failure) throw failure.reason;
}

export function throwPrioritizedCleanupFailure(
  proofResults: readonly PromiseSettledResult<unknown>[],
  ordinaryResults: readonly PromiseSettledResult<unknown>[],
  trailingResults: readonly PromiseSettledResult<unknown>[],
): void {
  assertMiniAppCleanupsProven([...proofResults, ...ordinaryResults]);
  throwFirstRejected(ordinaryResults);
  throwUnexpectedCleanupFailure(proofResults);
  throwFirstRejected(trailingResults);
}

export async function ignoreRejected(operation: Promise<unknown> | undefined): Promise<void> {
  if (!operation) return;
  try {
    await operation;
  } catch {
    // The operation owner records its typed failure.
  }
}

export async function clearAfterSettlement(
  operation: Promise<unknown>,
  clear: () => void,
): Promise<void> {
  try {
    await operation;
  } catch {
    // The original operation remains the caller-visible rejection.
  } finally {
    clear();
  }
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    resolvesTrue(operation),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return settled;
}

async function resolvesTrue(operation: Promise<unknown>): Promise<true> {
  await operation;
  return true;
}

function isExpectedCancellation(error: unknown): boolean {
  return (
    error instanceof MiniAppError &&
    (error.code === 'CLOSED' || error.code === 'DISABLED' || error.code === 'SUPERSEDED')
  );
}
