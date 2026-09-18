import type {
  MiniAppHostConnectorQuiesceAttempt,
  MiniAppNodeRuntime,
  MiniAppStateStore,
} from '../contracts.js';
import * as cleanup from './cleanup-settlement.js';
import * as errors from '../errors.js';
import { MiniAppCleanupUnprovenError, MiniAppError } from '../errors.js';
import { publishedView, type MiniAppGeneration } from './supervisor-generation.js';
import { persistExplicitStartFence, type SupervisorPreparation } from './supervisor-transition.js';

export class SupervisorCutoverCoordinator {
  constructor(
    private readonly options: {
      readonly active: Map<string, MiniAppGeneration>;
      readonly retiring: Map<string, MiniAppGeneration[]>;
      readonly quiescing: Map<string, SupervisorPreparation>;
      readonly explicitlyStopped: Set<string>;
      readonly stateStore: MiniAppStateStore;
      readonly nowMs: () => number;
      readonly isClosed: () => boolean;
      readonly isQuarantined: (pluginId: string) => boolean;
      readonly assertCurrentPreparation: (
        pluginId: string,
        preparation: SupervisorPreparation,
      ) => void;
      readonly quarantineCleanupFailure: (pluginId: string, error: unknown) => boolean;
    },
  ) {}

  async prepare(input: {
    readonly pluginId: string;
    readonly generation: MiniAppGeneration;
    readonly preparation: SupervisorPreparation;
    readonly deadlineMs: number;
    readonly validate: () => Promise<void>;
    readonly onPonr: () => void;
  }): Promise<void> {
    if (input.generation.retirementPromise) {
      await input.generation.retirementPromise;
      this.options.assertCurrentPreparation(input.pluginId, input.preparation);
      return;
    }
    const runtime = input.generation.runtime;
    if (!runtime) return;
    return prepareDestructiveCutover({
      runtime,
      generation: input.generation,
      deadlineMs: input.deadlineMs,
      signal: input.preparation.controller.signal,
      beginQuiescing: () => this.options.quiescing.set(input.pluginId, input.preparation),
      endQuiescing: () => this.endQuiescing(input.pluginId, input.preparation),
      restorePrePonr: (accepting) => this.restorePrePonr(input, runtime, accepting),
      validate: input.validate,
      assertCurrent: () => this.assertGenerationCurrent(input.pluginId, input.generation, runtime),
      onPonr: input.onPonr,
      persistExplicitStartFence: () =>
        persistExplicitStartFence(this.options.stateStore, input.pluginId, this.options.nowMs()),
      markExplicitlyStopped: () => this.options.explicitlyStopped.add(input.pluginId),
      markCold: () => this.markCold(input.generation, runtime),
      quarantine: (error) => this.options.quarantineCleanupFailure(input.pluginId, error),
      operationBusy: (message) =>
        new MiniAppError('BUSY', message, { busyReason: 'operation_busy' }),
    });
  }

  runtimeOwners(pluginId: string): readonly MiniAppGeneration[] {
    const active = this.options.active.get(pluginId);
    const generations = [
      ...(this.options.retiring.get(pluginId) ?? []),
      ...(active ? [active] : []),
    ];
    return generations.filter(
      (generation, index) =>
        Boolean(generation.runtime) && generations.indexOf(generation) === index,
    );
  }

  settleStarting(
    pluginId: string,
    generation: MiniAppGeneration,
    preparation: SupervisorPreparation,
    onPonr: () => void,
  ): Promise<void> {
    return settleStartingGeneration({
      generation,
      beginQuiescing: () => this.options.quiescing.set(pluginId, preparation),
      endQuiescing: () => this.endQuiescing(pluginId, preparation),
      assertCurrent: () => this.options.assertCurrentPreparation(pluginId, preparation),
      isQuarantined: () => this.options.isQuarantined(pluginId),
      persistExplicitStartFence: () =>
        persistExplicitStartFence(this.options.stateStore, pluginId, this.options.nowMs()),
      markExplicitlyStopped: () => this.options.explicitlyStopped.add(pluginId),
      onPonr,
    });
  }

  private endQuiescing(pluginId: string, preparation: SupervisorPreparation): void {
    if (this.options.quiescing.get(pluginId) === preparation) {
      this.options.quiescing.delete(pluginId);
    }
  }

  private restorePrePonr(
    input: { readonly pluginId: string; readonly generation: MiniAppGeneration },
    runtime: MiniAppNodeRuntime,
    accepting: boolean,
  ): void {
    if (
      this.options.active.get(input.pluginId) === input.generation &&
      input.generation.runtime === runtime &&
      !this.options.explicitlyStopped.has(input.pluginId)
    ) {
      input.generation.accepting = accepting;
    }
  }

  private assertGenerationCurrent(
    pluginId: string,
    generation: MiniAppGeneration,
    runtime: MiniAppNodeRuntime,
  ): void {
    const owned =
      this.options.active.get(pluginId) === generation ||
      (this.options.retiring.get(pluginId) ?? []).includes(generation);
    if (owned && generation.runtime === runtime && !this.options.isClosed()) return;
    throw new MiniAppError('SUPERSEDED', 'Mini App changed before destructive cutover');
  }

  private markCold(generation: MiniAppGeneration, runtime: MiniAppNodeRuntime): void {
    generation.accepting = false;
    generation.idleTimer?.cancel();
    generation.idleTimer = undefined;
    if (generation.runtime !== runtime) return;
    generation.runtime = undefined;
    generation.view = publishedView(generation.candidate, generation.view.miniAppGeneration);
  }
}

async function prepareDestructiveCutover(input: {
  readonly runtime: MiniAppNodeRuntime;
  readonly generation: MiniAppGeneration;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly beginQuiescing: () => void;
  readonly endQuiescing: () => void;
  readonly restorePrePonr: (previousAccepting: boolean) => void;
  readonly validate: () => Promise<void>;
  readonly assertCurrent: () => void;
  readonly onPonr: () => void;
  readonly persistExplicitStartFence: () => void;
  readonly markExplicitlyStopped: () => void;
  readonly markCold: () => void;
  readonly quarantine: (error: unknown) => void;
  readonly operationBusy: (message: string) => MiniAppError;
}): Promise<void> {
  const previousAccepting = input.generation.accepting;
  input.generation.accepting = false;
  input.beginQuiescing();
  let connectorAttempt: MiniAppHostConnectorQuiesceAttempt | undefined;
  try {
    connectorAttempt = input.runtime.hostConnectorSession?.beginQuiesce({
      deadlineMs: input.deadlineMs,
      signal: input.signal,
    });
    if ((await (connectorAttempt?.result ?? Promise.resolve('drained'))) === 'busy') {
      if (input.signal.aborted) throw abortReason(input.signal);
      throw input.operationBusy('Mini App Host Connector calls are still active');
    }
    input.assertCurrent();
    await input.validate();
    input.assertCurrent();
    input.persistExplicitStartFence();
  } catch (error) {
    failPrePonr(input, connectorAttempt, previousAccepting, error);
  }

  input.markExplicitlyStopped();
  input.onPonr();
  const connectorCommit = await cleanup.captureOperation(
    connectorAttempt ? () => connectorAttempt.commit() : () => undefined,
  );
  const rootCleanup = await cleanup.captureOperation(() => cleanup.cleanupRuntime(input.runtime));
  input.endQuiescing();
  if (rootCleanup.status === 'rejected' && errors.isMiniAppCleanupUnproven(rootCleanup.reason)) {
    input.quarantine(rootCleanup.reason);
    throw rootCleanup.reason;
  }
  input.markCold();
  if (connectorCommit.status === 'rejected') throw connectorCommit.reason;
  if (rootCleanup.status === 'rejected') throw rootCleanup.reason;
}

function failPrePonr(
  input: Parameters<typeof prepareDestructiveCutover>[0],
  connectorAttempt: MiniAppHostConnectorQuiesceAttempt | undefined,
  previousAccepting: boolean,
  error: unknown,
): never {
  if (connectorAttempt?.resume() ?? true) {
    input.restorePrePonr(previousAccepting);
    input.endQuiescing();
    throw error;
  }
  input.onPonr();
  input.markExplicitlyStopped();
  input.endQuiescing();
  const failure = new MiniAppCleanupUnprovenError(
    'Mini App Host Connector admission could not be restored before cutover',
    { cause: error },
  );
  input.quarantine(failure);
  throw failure;
}

async function settleStartingGeneration(input: {
  readonly generation: MiniAppGeneration;
  readonly beginQuiescing: () => void;
  readonly endQuiescing: () => void;
  readonly assertCurrent: () => void;
  readonly isQuarantined: () => boolean;
  readonly persistExplicitStartFence: () => void;
  readonly markExplicitlyStopped: () => void;
  readonly onPonr: () => void;
}): Promise<void> {
  const startup = input.generation.startPromise;
  if (!startup || input.generation.runtime) return;
  input.beginQuiescing();
  try {
    input.assertCurrent();
    input.persistExplicitStartFence();
    input.markExplicitlyStopped();
    input.generation.accepting = false;
    input.generation.startController?.abort(
      new MiniAppError('SUPERSEDED', 'Mini App startup was superseded by an explicit operation'),
    );
    input.onPonr();
    await cleanup.ignoreRejected(startup);
    input.assertCurrent();
    if (input.isQuarantined()) {
      throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
    }
    // An abort-insensitive startup may still publish a runtime while cleanup settles;
    // the caller already crossed PONR and will retire it through the normal root owner.
  } finally {
    input.endQuiescing();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new MiniAppError('SUPERSEDED', 'Mini App cutover was cancelled');
}
