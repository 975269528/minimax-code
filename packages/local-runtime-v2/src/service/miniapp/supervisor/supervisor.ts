import { randomUUID } from 'node:crypto';

import type {
  MiniAppCandidate,
  MiniAppGenerationLease,
  MiniAppNodeRuntime,
  MiniAppPreparationOptions,
  MiniAppPublishedView,
  MiniAppRuntimeLogEvent,
  MiniAppRuntimeLogEntry,
  MiniAppStopOptions,
  MiniAppStatus,
  MiniAppSupervisor,
  MiniAppSupervisorOptions,
  PreparedMiniAppDisableTransition,
  PreparedMiniAppStopTransition,
  PreparedMiniAppTransition,
} from '../contracts.js';
import * as cleanup from './cleanup-settlement.js';
import * as errors from '../errors.js';
import { MiniAppError } from '../errors.js';
import { sanitizeMiniAppRuntimeLogEvent } from '../runtime-log.js';
import {
  activeStatusPhase,
  assertGenerationRunCurrent,
  assertReusableRuntimeCurrent,
  isReusableGeneration,
  type MiniAppGeneration as Generation,
  persistedState,
  publishedView,
  scheduleTimeout,
} from './supervisor-generation.js';
import {
  capturePublicationMemory,
  createSupervisorPreparation,
  disablePreparationCancellation,
  disableRolledBackError,
  explicitStartRequiredJson,
  persistedErrorDetail,
  persistExplicitStartFence,
  type PublicationMemoryCollections,
  type PublicationMemorySnapshot,
  removeRetiringGeneration,
  restorePublicationMemory,
  restorePublicationPersistence,
  rollbackCommittedGeneration,
  type SupervisorPreparation as Preparation,
} from './supervisor-transition.js';
import { SupervisorCutoverCoordinator } from './supervisor-cutover.js';

interface ReusableRuntime {
  readonly generation: Generation;
  readonly runtime: MiniAppNodeRuntime;
}

type LeaseRequest = Parameters<MiniAppSupervisor['acquire']>[0];

export class DefaultMiniAppSupervisor implements MiniAppSupervisor {
  private readonly active = new Map<string, Generation>();
  private readonly retiring = new Map<string, Generation[]>();
  private readonly disabled = new Set<string>();
  private readonly cold = new Set<string>();
  private readonly preparations = new Map<string, Preparation>();
  private readonly failures = new Map<string, string>();
  private readonly quarantined = new Set<string>();
  private readonly explicitlyStopped = new Set<string>();
  private readonly quiescing = new Map<string, Preparation>();
  private readonly publicationMemory: PublicationMemoryCollections = {
    disabled: this.disabled,
    cold: this.cold,
    quarantined: this.quarantined,
    failures: this.failures,
    explicitlyStopped: this.explicitlyStopped,
  };
  private readonly logs = new Map<string, MiniAppRuntimeLogEntry[]>();
  private readonly observations = new Set<Promise<void>>();
  private readonly cutover: SupervisorCutoverCoordinator;
  private logSequence = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: MiniAppSupervisorOptions) {
    this.cutover = new SupervisorCutoverCoordinator({
      active: this.active,
      retiring: this.retiring,
      quiescing: this.quiescing,
      explicitlyStopped: this.explicitlyStopped,
      stateStore: options.stateStore,
      nowMs: () => this.nowMs(),
      isClosed: () => this.closed,
      isQuarantined: (pluginId) => this.quarantined.has(pluginId),
      assertCurrentPreparation: (pluginId, preparation) =>
        this.assertCurrentPreparation(pluginId, preparation),
      quarantineCleanupFailure: (pluginId, error) => this.quarantineCleanupFailure(pluginId, error),
    });
  }

  async ready(): Promise<void> {
    this.assertOpen();
    for (const state of this.options.stateStore.list()) {
      this.cold.add(state.pluginId);
      const persistedError = persistedErrorDetail(state.lastErrorJson);
      if (persistedError.requiresExplicitStart) {
        this.explicitlyStopped.add(state.pluginId);
        if (persistedError.code) this.failures.set(state.pluginId, persistedError.code);
      }
    }
  }

  prepare(
    candidate: MiniAppCandidate,
    options: MiniAppPreparationOptions = {},
  ): Promise<PreparedMiniAppTransition> {
    this.assertOpen();
    const existing = this.preparations.get(candidate.pluginId);
    const preparation = createSupervisorPreparation(options.signal);
    this.preparations.set(candidate.pluginId, preparation);
    preparation.promise = this.prepareAfterSuperseding(candidate, options, preparation, existing);
    return preparation.promise as Promise<PreparedMiniAppTransition>;
  }

  private async prepareAfterSuperseding(
    candidate: MiniAppCandidate,
    options: MiniAppPreparationOptions,
    preparation: Preparation,
    existing: Preparation | undefined,
  ): Promise<PreparedMiniAppTransition> {
    if (existing) {
      existing.controller.abort(
        new MiniAppError('SUPERSEDED', 'Mini App transition was superseded'),
      );
      try {
        const transition = await existing.promise;
        await transition.rollback();
      } catch (error) {
        if (!(error instanceof MiniAppError) || error.code !== 'SUPERSEDED') {
          this.clearPreparation(candidate.pluginId, preparation);
          throw error;
        }
      } finally {
        existing.unlinkSignal();
      }
    }
    return this.prepareOwned(candidate, options, preparation);
  }

  private async prepareOwned(
    candidate: MiniAppCandidate,
    options: MiniAppPreparationOptions,
    preparation: Preparation,
  ): Promise<PreparedMiniAppTransition> {
    const miniAppGeneration = this.makeMiniAppGeneration();
    let reusable: ReusableRuntime | undefined;
    let runtime: MiniAppNodeRuntime | undefined;
    let ownsRuntime = false;
    let crossedPonr = options.forceStart === true && this.explicitlyStopped.has(candidate.pluginId);
    try {
      this.assertCurrentPreparation(candidate.pluginId, preparation);
      if (this.quarantined.has(candidate.pluginId)) {
        throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
      }
      await this.verifyCandidate(candidate, 'Mini App candidate changed during prepare');
      this.assertCurrentPreparation(candidate.pluginId, preparation);
      reusable = options.forceStart === true ? undefined : this.findReusableRuntime(candidate);
      runtime = await this.prepareCandidateRuntime(candidate, preparation, {
        miniAppGeneration,
        reusable,
        forceStart: options.forceStart === true,
        deadlineMs: this.resolveDrainDeadline(options.deadlineMs),
        onPonr: () => {
          crossedPonr = true;
        },
      });
      ownsRuntime = Boolean(runtime && !reusable);
      this.assertCurrentPreparation(candidate.pluginId, preparation);
      await this.verifyCandidate(candidate, 'Mini App candidate changed during readiness');
      this.assertCurrentPreparation(candidate.pluginId, preparation);
    } catch (error) {
      this.clearPreparation(candidate.pluginId, preparation);
      const reason = preparation.controller.signal.reason;
      const cleanupFailed = this.quarantineCleanupFailure(candidate.pluginId, error);
      const primary = cleanupFailed || !(reason instanceof Error) ? error : reason;
      const failure = await cleanup.selectFailureAfterCleanup(primary, () =>
        this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined),
      );
      if (crossedPonr && !errors.isMiniAppExpectedCancellation(errors.miniAppErrorCode(failure))) {
        this.recordFailure(candidate.pluginId, errors.miniAppErrorCode(failure));
      }
      throw failure;
    }
    const target = publishedView(candidate, miniAppGeneration, runtime);
    let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
    const commitOwner: { promise?: Promise<MiniAppPublishedView> } = {};
    let retiredGeneration: Generation | undefined;
    let committedGeneration: Generation | undefined;
    let previousGeneration: Generation | undefined;
    let previousAccepting = false;
    let persistenceCompensation: (() => void) | undefined;
    let memorySnapshot: PublicationMemorySnapshot | undefined;
    let finalized = false;
    return {
      candidate,
      target,
      willPublishCold: !runtime,
      commit: async () => {
        this.assertOpen();
        this.assertCurrentPreparation(candidate.pluginId, preparation);
        if (state === 'rolled-back') {
          throw new MiniAppError('SUPERSEDED', 'Mini App transition was rolled back');
        }
        if (commitOwner.promise) return commitOwner.promise;
        return cleanup.startOwnedOperation(commitOwner, async () => {
          try {
            assertReusableRuntimeCurrent(this.active, candidate, reusable);
            const previous = this.active.get(candidate.pluginId);
            previousGeneration = previous;
            previousAccepting = previous?.accepting ?? false;
            memorySnapshot = capturePublicationMemory(this.publicationMemory, candidate.pluginId);
            persistenceCompensation = await cleanup.acceptAndAdmitRuntime({
              accept: () => this.acceptPreparedRuntime(candidate, runtime, ownsRuntime),
              retirementOwners: () => this.retiring.get(candidate.pluginId) ?? [],
              isQuarantined: () => this.quarantined.has(candidate.pluginId),
              assertCurrent: () => this.assertCurrentPreparation(candidate.pluginId, preparation),
              admit: () => {
                retiredGeneration = this.publishPreparedGeneration({
                  candidate,
                  target,
                  runtime,
                  reusable,
                });
                committedGeneration = this.active.get(candidate.pluginId);
              },
              shouldCompensate: () => this.active.get(candidate.pluginId) === previous,
              cleanup: () =>
                this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined),
            });
          } catch (error) {
            state = 'rolled-back';
            this.clearPreparation(candidate.pluginId, preparation);
            throw error;
          }
          state = 'committed';
          this.clearPreparation(candidate.pluginId, preparation);
          return target;
        });
      },
      rollback: async () => {
        if (commitOwner.promise) await commitOwner.promise;
        if (state === 'prepared') {
          state = 'rolled-back';
          this.clearPreparation(candidate.pluginId, preparation);
          await this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined);
          return;
        }
        if (
          state !== 'committed' ||
          finalized ||
          !committedGeneration ||
          !memorySnapshot ||
          !persistenceCompensation
        ) {
          return;
        }
        const rollbackSnapshot = memorySnapshot;
        try {
          await rollbackCommittedGeneration({
            pluginId: candidate.pluginId,
            active: this.active,
            retiring: this.retiring,
            committedGeneration,
            previousGeneration,
            previousAccepting,
            persistenceCompensation,
            restoreMemory: () =>
              restorePublicationMemory(
                this.publicationMemory,
                candidate.pluginId,
                rollbackSnapshot,
              ),
            reusableGeneration: reusable?.generation,
            runtimeWasReused: Boolean(reusable),
            cleanupRuntime: (ownedRuntime) =>
              this.cleanupOrQuarantine(candidate.pluginId, ownedRuntime),
          });
        } finally {
          state = 'rolled-back';
        }
      },
      finalize: async () => {
        if (state !== 'committed' || finalized) return;
        finalized = true;
        if (!retiredGeneration) return;
        retiredGeneration.retirementPendingFinalization = false;
        await this.removeRetiredIfDrained(candidate.pluginId, retiredGeneration);
      },
    };
  }

  private async prepareCandidateRuntime(
    candidate: MiniAppCandidate,
    preparation: Preparation,
    options: {
      readonly miniAppGeneration: string;
      readonly reusable: ReusableRuntime | undefined;
      readonly forceStart: boolean;
      readonly deadlineMs: number;
      readonly onPonr: () => void;
    },
  ): Promise<MiniAppNodeRuntime | undefined> {
    if (options.reusable) return options.reusable.runtime;
    if (!options.forceStart) return undefined;
    const current = this.active.get(candidate.pluginId);
    if (current) {
      await this.cutover.settleStarting(candidate.pluginId, current, preparation, options.onPonr);
    }
    for (const generation of this.cutover.runtimeOwners(candidate.pluginId)) {
      await this.cutover.prepare({
        pluginId: candidate.pluginId,
        generation,
        preparation,
        deadlineMs: options.deadlineMs,
        validate: async () => {
          this.assertCurrentPreparation(candidate.pluginId, preparation);
          await this.verifyCandidate(candidate, 'Mini App candidate changed before cutover');
          this.assertCurrentPreparation(candidate.pluginId, preparation);
        },
        onPonr: options.onPonr,
      });
    }
    return this.options.nodeRuntime.prepare({
      candidate,
      processGeneration: this.makeProcessGeneration(),
      signal: preparation.controller.signal,
      onLog: (event) => this.appendLog(candidate.pluginId, options.miniAppGeneration, event),
    });
  }

  private async acceptPreparedRuntime(
    candidate: MiniAppCandidate,
    runtime: MiniAppNodeRuntime | undefined,
    ownsRuntime: boolean,
  ): Promise<() => void> {
    return cleanup.acceptRuntimePersistence({
      quarantined: this.quarantined.has(candidate.pluginId),
      readPrevious: () => this.options.stateStore.read(candidate.pluginId),
      writeAccepted: (previous) => {
        const accepted = persistedState(candidate, runtime, this.nowMs());
        this.options.stateStore.write(
          !runtime && this.explicitlyStopped.has(candidate.pluginId)
            ? {
                ...accepted,
                lastErrorJson: explicitStartRequiredJson(previous?.lastErrorJson),
              }
            : accepted,
        );
      },
      restore: (previous) => this.restorePersistedState(candidate.pluginId, previous),
      ...(ownsRuntime ? { activate: () => runtime?.hostConnectorSession?.activate() } : {}),
      cleanup: () =>
        this.cleanupOrQuarantine(candidate.pluginId, ownsRuntime ? runtime : undefined),
    });
  }

  private async cleanupOrQuarantine(
    pluginId: string,
    runtime: MiniAppNodeRuntime | undefined,
  ): Promise<void> {
    try {
      await cleanup.cleanupRuntime(runtime);
    } catch (error) {
      this.quarantineCleanupFailure(pluginId, error);
      throw error;
    }
  }

  private quarantineCleanupFailure(pluginId: string, error: unknown): boolean {
    if (!errors.isMiniAppCleanupUnproven(error)) return false;
    this.quarantined.add(pluginId);
    this.recordFailure(pluginId, 'CLEANUP_UNPROVEN');
    return true;
  }

  private publishPreparedGeneration(input: {
    readonly candidate: MiniAppCandidate;
    readonly target: MiniAppPublishedView;
    readonly runtime: MiniAppNodeRuntime | undefined;
    readonly reusable: ReusableRuntime | undefined;
  }): Generation | undefined {
    const { candidate, target, runtime, reusable } = input;
    const previous = this.active.get(candidate.pluginId);
    if (previous) {
      if (reusable?.generation === previous) previous.runtime = undefined;
      this.addRetiring(previous, true);
    }
    this.active.set(candidate.pluginId, {
      candidate,
      view: target,
      leases: new Set(),
      accepting: Boolean(runtime),
      ...(runtime ? { runtime } : {}),
    });
    if (runtime && !reusable) this.observeRuntime(candidate.pluginId, runtime);
    if (runtime || !this.explicitlyStopped.has(candidate.pluginId)) {
      this.failures.delete(candidate.pluginId);
    }
    this.quarantined.delete(candidate.pluginId);
    this.disabled.delete(candidate.pluginId);
    this.cold.delete(candidate.pluginId);
    if (runtime) this.explicitlyStopped.delete(candidate.pluginId);
    return previous;
  }

  private findReusableRuntime(candidate: MiniAppCandidate): ReusableRuntime | undefined {
    const generation = this.active.get(candidate.pluginId);
    if (!generation || !isReusableGeneration(generation, candidate)) return undefined;
    return { generation, runtime: generation.runtime };
  }

  async acquire(input: LeaseRequest): Promise<MiniAppGenerationLease> {
    this.assertOpen();
    let generation = this.admitLease(input);
    generation.idleTimer?.cancel();
    generation.idleTimer = undefined;
    const runtime =
      generation.accepting && generation.runtime
        ? generation.runtime
        : await this.ensureOnDemandRuntime(input.pluginId, generation);
    generation = this.admitRunningLease(input, runtime);
    const leaseId = this.options.makeLeaseId?.() ?? randomUUID();
    generation.leases.add(leaseId);
    let released = false;
    return {
      release: async () => {
        if (released) return false;
        released = true;
        generation.leases.delete(leaseId);
        await this.removeRetiredIfDrained(input.pluginId, generation);
        this.scheduleIdleDrain(input.pluginId, generation);
        return true;
      },
    };
  }

  assertCurrentRun(input: { readonly pluginId: string; readonly runId: string }): undefined {
    return assertGenerationRunCurrent({
      active: this.active,
      pluginId: input.pluginId,
      runId: input.runId,
      unavailable:
        this.closed || this.disabled.has(input.pluginId) || this.quarantined.has(input.pluginId),
    });
  }

  prepareStop(
    pluginId: string,
    options: MiniAppStopOptions = {},
  ): Promise<PreparedMiniAppStopTransition> {
    this.assertOpen();
    const existing = this.preparations.get(pluginId);
    const preparation = createSupervisorPreparation(options.signal);
    this.preparations.set(pluginId, preparation);
    preparation.promise = this.prepareStopAfterSuperseding(
      pluginId,
      options,
      preparation,
      existing,
    );
    return preparation.promise as Promise<PreparedMiniAppStopTransition>;
  }

  private async prepareStopAfterSuperseding(
    pluginId: string,
    options: MiniAppStopOptions,
    preparation: Preparation,
    existing: Preparation | undefined,
  ): Promise<PreparedMiniAppStopTransition> {
    if (existing) {
      existing.controller.abort(
        new MiniAppError('SUPERSEDED', 'Mini App transition was superseded'),
      );
      try {
        const transition = await existing.promise;
        await transition.rollback();
      } catch (error) {
        if (!(error instanceof MiniAppError) || error.code !== 'SUPERSEDED') {
          this.clearPreparation(pluginId, preparation);
          throw error;
        }
      } finally {
        existing.unlinkSignal();
      }
    }
    return this.prepareStopOwned(pluginId, options, preparation);
  }

  private async prepareStopOwned(
    pluginId: string,
    options: MiniAppStopOptions,
    preparation: Preparation,
  ): Promise<PreparedMiniAppStopTransition> {
    let crossedPonr = false;
    let generation: Generation;
    try {
      this.assertCurrentPreparation(pluginId, preparation);
      if (this.quarantined.has(pluginId)) {
        throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
      }
      generation = this.requireActiveGeneration(pluginId);
      await this.cutover.settleStarting(pluginId, generation, preparation, () => {
        crossedPonr = true;
      });
      if (generation.runtime) {
        await this.cutover.prepare({
          pluginId,
          generation,
          preparation,
          deadlineMs: this.resolveDrainDeadline(options.deadlineMs),
          validate: async () => undefined,
          onPonr: () => {
            crossedPonr = true;
          },
        });
      } else {
        persistExplicitStartFence(this.options.stateStore, pluginId, this.nowMs());
        this.explicitlyStopped.add(pluginId);
        generation.accepting = false;
      }
      this.assertCurrentPreparation(pluginId, preparation);
    } catch (error) {
      this.clearPreparation(pluginId, preparation);
      if (crossedPonr && !errors.isMiniAppExpectedCancellation(errors.miniAppErrorCode(error))) {
        this.recordFailure(pluginId, errors.miniAppErrorCode(error));
      }
      throw error;
    }
    const target = generation.view;
    let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
    return {
      pluginId,
      target,
      commit: async () => {
        if (state === 'committed') return target;
        this.assertOpen();
        if (state === 'rolled-back') {
          throw new MiniAppError('SUPERSEDED', 'Mini App stop was rolled back');
        }
        this.assertCurrentPreparation(pluginId, preparation);
        if (this.active.get(pluginId) !== generation || generation.runtime) {
          throw new MiniAppError('SUPERSEDED', 'Mini App changed before stop commit');
        }
        state = 'committed';
        this.clearPreparation(pluginId, preparation);
        return target;
      },
      rollback: async () => {
        if (state === 'rolled-back') return;
        state = 'rolled-back';
        this.clearPreparation(pluginId, preparation);
      },
      finalize: async () => undefined,
    };
  }

  async stop(pluginId: string, options: MiniAppStopOptions = {}): Promise<void> {
    const transition = await this.prepareStop(pluginId, options);
    await transition.commit();
    await transition.finalize();
  }

  async prepareDisable(pluginId: string): Promise<PreparedMiniAppDisableTransition> {
    let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
    const commitOwner: { promise?: Promise<void> } = {};
    let previousGeneration: Generation | undefined;
    let previousAccepting = false;
    let previousState: ReturnType<MiniAppSupervisorOptions['stateStore']['read']>;
    let memorySnapshot: PublicationMemorySnapshot | undefined;
    let finalized = false;
    return {
      pluginId,
      commit: () => {
        if (state === 'rolled-back') {
          return Promise.reject(disableRolledBackError());
        }
        if (state === 'committed') return Promise.resolve();
        if (commitOwner.promise) return commitOwner.promise;
        return cleanup.startOwnedOperation(commitOwner, async () => {
          this.assertOpen();
          await this.cancelPreparation(pluginId, disablePreparationCancellation());
          if (state !== 'prepared') throw disableRolledBackError();
          previousGeneration = this.active.get(pluginId);
          previousAccepting = previousGeneration?.accepting ?? false;
          previousState = this.options.stateStore.read(pluginId);
          memorySnapshot = capturePublicationMemory(this.publicationMemory, pluginId);
          try {
            this.options.stateStore.remove(pluginId);
          } catch (cause) {
            throw new MiniAppError(
              'PERSISTENCE_WRITE_FAILED',
              'Mini App disable state could not be persisted',
              { cause },
            );
          }
          if (previousGeneration) {
            this.active.delete(pluginId);
            this.addRetiring(previousGeneration, true);
          }
          this.cold.delete(pluginId);
          this.explicitlyStopped.delete(pluginId);
          this.disabled.add(pluginId);
          state = 'committed';
        });
      },
      rollback: async () => {
        if (commitOwner.promise) await commitOwner.promise;
        if (state === 'prepared') {
          state = 'rolled-back';
          return;
        }
        if (state !== 'committed' || finalized || !memorySnapshot) return;
        if (previousGeneration) {
          removeRetiringGeneration(this.retiring, pluginId, previousGeneration);
          previousGeneration.accepting = previousAccepting;
          this.active.set(pluginId, previousGeneration);
        }
        restorePublicationMemory(this.publicationMemory, pluginId, memorySnapshot);
        this.restorePersistedState(pluginId, previousState);
        state = 'rolled-back';
      },
      finalize: async () => {
        if (state !== 'committed' || finalized) return;
        finalized = true;
        if (!previousGeneration) return;
        previousGeneration.retirementPendingFinalization = false;
        await this.removeRetiredIfDrained(pluginId, previousGeneration);
      },
    };
  }

  async disable(pluginId: string): Promise<void> {
    this.assertOpen();
    const disableReason = new MiniAppError('DISABLED', 'Mini App was disabled');
    const generation = this.active.get(pluginId);
    if (generation) generation.accepting = false;
    generation?.startController?.abort(disableReason);
    const settlement = await cleanup.settleDisableCleanup({
      preparation: this.cancelPreparation(pluginId, disableReason),
      startup: generation?.startPromise,
      cleanupGeneration: async () => {
        const current = this.active.get(pluginId) ?? generation;
        if (!current) return;
        this.active.delete(pluginId);
        this.addRetiring(current);
        await this.removeRetiredIfDrained(pluginId, current);
      },
      timeoutMs: this.options.closeTimeoutMs ?? 5_000,
    });
    for (const timeout of settlement.timeouts) this.quarantineCleanupFailure(pluginId, timeout);
    const stateRemoval = await cleanup.captureOperation(() =>
      this.options.stateStore.remove(pluginId),
    );
    if (stateRemoval.status === 'fulfilled') {
      this.cold.delete(pluginId);
      this.explicitlyStopped.delete(pluginId);
      this.disabled.add(pluginId);
    }
    cleanup.throwPrioritizedCleanupFailure(settlement.proofResults, settlement.generationResults, [
      stateRemoval,
    ]);
  }

  canReusePreparedPackage(input: {
    readonly pluginId: string;
    readonly packageDigest: string;
    readonly clientDigest: string;
    readonly nodeDigest: string;
  }): boolean {
    const state = this.options.stateStore.read(input.pluginId);
    return Boolean(
      state &&
      state.acceptedSourceDigest === input.packageDigest &&
      state.clientDigest === input.clientDigest &&
      state.nodeDigest === input.nodeDigest &&
      persistedErrorDetail(state.lastErrorJson).code !== 'PERSISTENCE_COMPENSATION_FAILED',
    );
  }

  inspect(pluginId?: string): readonly MiniAppStatus[] {
    const ids = pluginId
      ? [pluginId]
      : [
          ...new Set([
            ...this.active.keys(),
            ...this.retiring.keys(),
            ...this.disabled,
            ...this.cold,
            ...this.preparations.keys(),
            ...this.failures.keys(),
            ...this.quarantined,
            ...this.logs.keys(),
          ]),
        ];
    return ids.map((id) => this.statusFor(id));
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOwned();
    return this.closePromise;
  }

  private async closeOwned(): Promise<void> {
    this.closed = true;
    const closeReason = new MiniAppError('CLOSED', 'Mini App Supervisor is closed');
    const pendingPreparations = [...this.preparations.entries()];
    for (const [, preparation] of pendingPreparations) {
      preparation.controller.abort(closeReason);
    }
    const knownGenerations = new Set([
      ...this.active.values(),
      ...[...this.retiring.values()].flatMap((entries) => entries),
    ]);
    for (const generation of knownGenerations) {
      generation.idleTimer?.cancel();
      generation.startController?.abort(closeReason);
    }
    const settlement = await cleanup.settleSupervisorClose({
      preparations: pendingPreparations.map(([pluginId, preparation]) => ({
        pluginId,
        promise: preparation.promise,
      })),
      generations: [...knownGenerations],
      timeoutMs: this.options.closeTimeoutMs ?? 5_000,
      onPreparationFailure: (pluginId, error) => {
        if (!this.quarantineCleanupFailure(pluginId, error)) {
          this.recordFailure(pluginId, errors.miniAppErrorCode(error));
        }
      },
    });
    if (settlement.timeout) {
      const pluginIds = new Set([
        ...pendingPreparations.map(([pluginId]) => pluginId),
        ...[...knownGenerations].map((generation) => generation.candidate.pluginId),
      ]);
      for (const pluginId of pluginIds) {
        this.quarantineCleanupFailure(pluginId, settlement.timeout);
      }
      throw settlement.timeout;
    }
    this.active.clear();
    this.retiring.clear();
    errors.assertMiniAppCleanupsProven(settlement.results);
    cleanup.throwUnexpectedCleanupFailure(settlement.results);
  }

  private admitLease(input: LeaseRequest): Generation {
    if (this.disabled.has(input.pluginId)) {
      throw new MiniAppError('DISABLED', 'Mini App is disabled');
    }
    if (this.quarantined.has(input.pluginId)) {
      throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
    }
    if (this.quiescing.has(input.pluginId) || this.explicitlyStopped.has(input.pluginId)) {
      throw new MiniAppError('BUSY', 'Mini App requires an explicit start', {
        busyReason: 'operation_busy',
      });
    }
    const generation = this.requireActiveGeneration(input.pluginId);
    if (
      input.expectedMiniAppGeneration &&
      input.expectedMiniAppGeneration !== generation.view.miniAppGeneration
    ) {
      throw new MiniAppError('RETIRED_GENERATION', 'Mini App generation is retired');
    }
    if (
      input.expectedProcessGeneration &&
      input.expectedProcessGeneration !== generation.view.processGeneration
    ) {
      throw new MiniAppError('RETIRED_GENERATION', 'Mini App process generation is retired');
    }
    return generation;
  }

  private admitRunningLease(input: LeaseRequest, runtime: MiniAppNodeRuntime): Generation {
    const generation = this.admitLease(input);
    if (
      generation.accepting &&
      generation.runtime === runtime &&
      generation.view.processGeneration === runtime.processGeneration &&
      generation.candidate.nodeDigest === runtime.nodeDigest
    ) {
      return generation;
    }
    throw new MiniAppError(
      'SERVICE_RESTARTED',
      'Mini App runtime changed before the generation lease could be admitted',
    );
  }

  private requireActiveGeneration(pluginId: string): Generation {
    const generation = this.active.get(pluginId);
    if (!generation) {
      throw new MiniAppError('NO_ACTIVE_GENERATION', 'Mini App has no active generation');
    }
    return generation;
  }

  private statusFor(pluginId: string): MiniAppStatus {
    const active = this.active.get(pluginId);
    const retiring = this.retiring.get(pluginId) ?? [];
    const failureCode = this.failures.get(pluginId);
    return {
      pluginId,
      phase: this.statusPhase(pluginId, active),
      ...(active ? { active: active.view } : {}),
      retiringGenerationIds: retiring.map((generation) => generation.view.miniAppGeneration),
      leaseCount:
        (active?.leases.size ?? 0) +
        retiring.reduce((count, generation) => count + generation.leases.size, 0),
      ...(failureCode ? { failureCode } : {}),
      logs: [...(this.logs.get(pluginId) ?? [])],
    };
  }

  private statusPhase(pluginId: string, active: Generation | undefined): MiniAppStatus['phase'] {
    if (this.quarantined.has(pluginId)) return 'quarantined';
    if (this.disabled.has(pluginId)) return 'disabled';
    if (active) return activeStatusPhase(active, this.failures.has(pluginId));
    if (this.preparations.has(pluginId)) return 'preparing';
    if (this.failures.has(pluginId)) return 'failed';
    if (this.cold.has(pluginId)) return 'cold';
    return 'inactive';
  }

  private addRetiring(generation: Generation, pendingFinalization = false): void {
    generation.accepting = false;
    generation.retirementPendingFinalization ||= pendingFinalization;
    generation.idleTimer?.cancel();
    generation.idleTimer = undefined;
    const entries = this.retiring.get(generation.candidate.pluginId) ?? [];
    entries.push(generation);
    this.retiring.set(generation.candidate.pluginId, entries);
  }

  private removeRetiredIfDrained(pluginId: string, generation: Generation): Promise<void> {
    if (generation.leases.size !== 0) return Promise.resolve();
    if (generation.retirementPendingFinalization) return Promise.resolve();
    if (!(this.retiring.get(pluginId) ?? []).includes(generation)) return Promise.resolve();
    generation.retirementPromise ??= this.cleanupRetiredGeneration(pluginId, generation);
    return generation.retirementPromise;
  }

  private async cleanupRetiredGeneration(pluginId: string, generation: Generation): Promise<void> {
    try {
      await generation.idleStopPromise;
      await cleanup.cleanupRuntime(generation.runtime);
    } catch (error) {
      if (!errors.isMiniAppCleanupUnproven(error) && errors.isMiniAppRootTerminationProven(error)) {
        generation.runtime = undefined;
        generation.view = publishedView(
          generation.candidate,
          generation.view.miniAppGeneration,
          undefined,
        );
        removeRetiringGeneration(this.retiring, pluginId, generation);
      }
      if (!this.quarantineCleanupFailure(pluginId, error)) {
        this.recordFailure(pluginId, errors.miniAppErrorCode(error));
      }
      throw error;
    }
    removeRetiringGeneration(this.retiring, pluginId, generation);
  }

  private async ensureOnDemandRuntime(
    pluginId: string,
    generation: Generation,
  ): Promise<MiniAppNodeRuntime> {
    if (generation.idleStopPromise) await generation.idleStopPromise;
    if (this.quarantined.has(pluginId)) {
      throw new MiniAppError('QUARANTINED', 'Mini App cleanup ownership is unproven');
    }
    if (generation.runtime) return generation.runtime;
    if (generation.startPromise) return generation.startPromise;
    const candidate = generation.candidate;
    const controller = new AbortController();
    generation.startController = controller;
    const operation = this.startOnDemandRuntime(pluginId, generation, candidate, controller);
    generation.startPromise = operation;
    const clear = () => {
      if (generation.startPromise === operation) {
        generation.startPromise = undefined;
        generation.startController = undefined;
      }
    };
    this.trackSettlement(operation, clear);
    return operation;
  }

  private async startOnDemandRuntime(
    pluginId: string,
    generation: Generation,
    candidate: MiniAppCandidate,
    controller: AbortController,
  ): Promise<MiniAppNodeRuntime> {
    let runtime: MiniAppNodeRuntime | undefined;
    let acceptanceAttempted = false;
    try {
      if (!(await this.options.verifyCandidate(candidate))) {
        throw new MiniAppError('CANDIDATE_CHANGED', 'Mini App candidate changed before start');
      }
      runtime = await this.options.nodeRuntime.prepare({
        candidate,
        processGeneration: this.makeProcessGeneration(),
        preferredPort: this.options.stateStore.read(pluginId)?.preferredPort,
        signal: controller.signal,
        onLog: (event) => this.appendLog(pluginId, generation.view.miniAppGeneration, event),
      });
      this.assertGenerationCurrent(pluginId, generation, controller);
      if (!(await this.options.verifyCandidate(candidate))) {
        throw new MiniAppError('CANDIDATE_CHANGED', 'Mini App candidate changed during start');
      }
      this.assertGenerationCurrent(pluginId, generation, controller);
      acceptanceAttempted = true;
      await cleanup.acceptAndAdmitRuntime({
        accept: () => this.acceptPreparedRuntime(candidate, runtime, true),
        retirementOwners: () => this.retiring.get(pluginId) ?? [],
        isQuarantined: () => this.quarantined.has(pluginId),
        assertCurrent: () => this.assertGenerationCurrent(pluginId, generation, controller),
        admit: () => {
          generation.runtime = runtime;
          generation.view = publishedView(candidate, generation.view.miniAppGeneration, runtime);
          generation.accepting = true;
        },
        shouldCompensate: () => this.active.get(pluginId) === generation,
        cleanup: () => this.cleanupOrQuarantine(pluginId, runtime),
      });
      this.failures.delete(pluginId);
      this.observeRuntime(pluginId, runtime);
      return runtime;
    } catch (error) {
      const failure = acceptanceAttempted
        ? error
        : await cleanup.selectFailureAfterCleanup(error, () =>
            this.cleanupOrQuarantine(pluginId, runtime),
          );
      const quarantined = this.quarantineCleanupFailure(pluginId, failure);
      const code = errors.miniAppErrorCode(failure);
      if (!quarantined && !errors.isMiniAppExpectedCancellation(code)) {
        this.recordFailure(pluginId, code, !acceptanceAttempted);
      }
      throw errors.normalizeMiniAppRuntimeError(failure, 'Mini App startup failed');
    }
  }

  private scheduleIdleDrain(pluginId: string, generation: Generation): void {
    if (
      this.active.get(pluginId) !== generation ||
      generation.leases.size !== 0 ||
      !generation.runtime ||
      generation.idleTimer ||
      generation.idleStopPromise
    ) {
      return;
    }
    const schedule = this.options.scheduleIdle ?? scheduleTimeout;
    generation.idleTimer = schedule(this.options.idleTimeoutMs ?? 30_000, () => {
      generation.idleTimer = undefined;
      const operation = this.drainIdleRuntime(pluginId, generation);
      generation.idleStopPromise = operation;
      const clear = () => {
        if (generation.idleStopPromise === operation) generation.idleStopPromise = undefined;
      };
      this.trackSettlement(operation, clear);
    });
  }

  private async drainIdleRuntime(pluginId: string, generation: Generation): Promise<void> {
    const runtime = generation.runtime;
    if (!runtime || this.active.get(pluginId) !== generation || generation.leases.size !== 0) {
      return;
    }
    const clearProvenRuntime = () => {
      if (generation.runtime !== runtime) return;
      generation.runtime = undefined;
      generation.view = publishedView(
        generation.candidate,
        generation.view.miniAppGeneration,
        undefined,
      );
    };
    generation.accepting = false;
    try {
      await cleanup.cleanupRuntime(runtime);
      clearProvenRuntime();
    } catch (error) {
      if (!errors.isMiniAppCleanupUnproven(error) && errors.isMiniAppRootTerminationProven(error)) {
        clearProvenRuntime();
      }
      if (!this.quarantineCleanupFailure(pluginId, error)) {
        this.recordFailure(pluginId, errors.miniAppErrorCode(error));
      }
      throw error;
    }
  }

  private appendLog(
    pluginId: string,
    miniAppGeneration: string,
    event: MiniAppRuntimeLogEvent,
  ): void {
    const sanitized = sanitizeMiniAppRuntimeLogEvent(event);
    const entries = this.logs.get(pluginId) ?? [];
    entries.push({
      ...sanitized,
      sequence: (this.logSequence += 1),
      atMs: this.nowMs(),
      miniAppGeneration,
    });
    const capacity = Math.max(1, this.options.logCapacity ?? 200);
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    this.logs.set(pluginId, entries);
  }

  private recordFailure(pluginId: string, code: string, persist = true): void {
    this.failures.set(pluginId, code);
    if (!persist) return;
    try {
      const state = this.options.stateStore.read(pluginId);
      if (!state) return;
      this.options.stateStore.write({
        ...state,
        lastErrorJson: this.explicitlyStopped.has(pluginId)
          ? explicitStartRequiredJson(state.lastErrorJson, code)
          : JSON.stringify({ code }),
        updatedAtMs: Math.max(this.nowMs(), state.updatedAtMs),
      });
    } catch {
      // Runtime failure identity remains observable in memory when persistence is unavailable.
    }
  }

  private restorePersistedState(
    pluginId: string,
    previous: ReturnType<MiniAppSupervisorOptions['stateStore']['read']>,
  ): void {
    restorePublicationPersistence({
      stateStore: this.options.stateStore,
      pluginId,
      previous:
        previous && this.explicitlyStopped.has(pluginId)
          ? {
              ...previous,
              lastErrorJson: explicitStartRequiredJson(previous.lastErrorJson),
            }
          : previous,
      onFailure: (failure) => {
        this.quarantined.add(pluginId);
        this.recordFailure(pluginId, failure.code);
      },
    });
  }

  private async cancelPreparation(pluginId: string, reason: MiniAppError): Promise<void> {
    const preparation = this.preparations.get(pluginId);
    if (!preparation) return;
    preparation.controller.abort(reason);
    try {
      await cleanup.settlePreparedTransitionCleanup(
        preparation.promise,
        this.options.closeTimeoutMs ?? 5_000,
      );
    } catch (error) {
      if (!errors.isMiniAppCleanupUnproven(error)) {
        this.recordFailure(pluginId, errors.miniAppErrorCode(error));
        throw error;
      }
      this.clearPreparation(pluginId, preparation);
      this.quarantineCleanupFailure(pluginId, error);
      throw error;
    }
  }

  private assertGenerationCurrent(
    pluginId: string,
    generation: Generation,
    controller: AbortController,
  ): void {
    if (!controller.signal.aborted && !this.closed && this.active.get(pluginId) === generation) {
      return;
    }
    throw errors.cancellationOrSupersededError(
      controller.signal,
      'Mini App runtime operation was superseded',
    );
  }

  private trackSettlement(operation: Promise<unknown>, clear: () => void): void {
    const observed = cleanup.clearAfterSettlement(operation, () => {
      clear();
      this.observations.delete(observed);
    });
    this.observations.add(observed);
  }

  private async verifyCandidate(candidate: MiniAppCandidate, message: string): Promise<void> {
    if (!(await this.options.verifyCandidate(candidate))) {
      throw new MiniAppError('CANDIDATE_CHANGED', message);
    }
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private makeMiniAppGeneration(): string {
    return this.options.makeMiniAppGeneration?.() ?? randomUUID();
  }

  private makeProcessGeneration(): string {
    return this.options.makeProcessGeneration?.() ?? randomUUID();
  }

  private observeRuntime(pluginId: string, runtime: MiniAppNodeRuntime): void {
    this.trackSettlement(this.handleRuntimeExit(pluginId, runtime), () => undefined);
  }

  private async handleRuntimeExit(pluginId: string, runtime: MiniAppNodeRuntime): Promise<void> {
    const terminal = await cleanup.captureOperation(() => runtime.closed);
    if (terminal.status === 'rejected') {
      const generation = this.active.get(pluginId);
      if (this.closed || generation?.runtime !== runtime) return;
      generation.accepting = false;
      await this.cleanupExitedRuntime(pluginId, runtime, terminal.reason);
      return;
    }
    const exit = terminal.value;
    if (exit.shutdownRequested || this.closed) return;
    const generation = this.active.get(pluginId);
    if (generation?.runtime !== runtime) return;
    generation.accepting = false;
    this.recordFailure(pluginId, 'RUNTIME_EXITED');
    generation.runtime = undefined;
    generation.view = publishedView(
      generation.candidate,
      generation.view.miniAppGeneration,
      undefined,
    );
    await this.cleanupExitedRuntime(pluginId, runtime);
  }

  private async cleanupExitedRuntime(
    pluginId: string,
    runtime: MiniAppNodeRuntime,
    terminalFailure?: unknown,
  ): Promise<void> {
    for (const error of await cleanup.collectRuntimeCleanupFailures(runtime, terminalFailure)) {
      if (!this.quarantineCleanupFailure(pluginId, error)) {
        this.recordFailure(pluginId, errors.miniAppErrorCode(error));
      }
    }
  }

  private assertCurrentPreparation(pluginId: string, preparation: Preparation): void {
    if (this.preparations.get(pluginId) === preparation && !preparation.controller.signal.aborted) {
      return;
    }
    throw errors.cancellationOrSupersededError(
      preparation.controller.signal,
      'Mini App transition was superseded',
    );
  }

  private resolveDrainDeadline(deadlineMs: number | undefined): number {
    return deadlineMs ?? Date.now() + (this.options.closeTimeoutMs ?? 5_000);
  }

  private clearPreparation(pluginId: string, preparation: Preparation): void {
    if (this.preparations.get(pluginId) !== preparation) return;
    this.preparations.delete(pluginId);
    preparation.unlinkSignal();
  }

  private assertOpen(): void {
    if (this.closed) throw new MiniAppError('CLOSED', 'Mini App Supervisor is closed');
  }
}
