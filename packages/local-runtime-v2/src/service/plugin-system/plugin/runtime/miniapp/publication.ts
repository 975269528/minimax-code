import { miniAppBusyReason, miniAppFailureReasonCode } from '../../../../miniapp/index.js';

import type { PluginSnapshotBuildInputs, PluginSnapshotBuildOptions } from '../../../contracts.js';
import { PluginSystemError } from '../../../errors.js';
import { runAllFinally } from '../../../plugin-system-helpers.js';
import {
  withPluginMcpRuntime,
  type PluginSnapshot,
  type PluginSnapshotMcpServer,
} from '../snapshot-builder.js';
import {
  listAcceptedMiniApps,
  listEnabledMiniAppDefinitions,
  miniAppCandidateFromPackage,
  sameMiniAppCandidate,
  type MiniAppDefinition,
  type PluginMiniAppCandidate,
} from './candidate.js';
import {
  buildSelectiveMiniAppInputs,
  miniAppManagedServerNames,
  ordinaryPackageContribution,
  retainRuntimeMiniAppContribution,
  withEnabledPluginRoster,
  type MiniAppSnapshotBuildContext,
  type PackageInput,
} from './projection.js';

interface PluginMiniAppPublishedView {
  readonly pluginId: string;
  readonly miniAppGeneration: string;
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly clientDigest: string;
  readonly surfacePath: string;
  readonly nodeDigest: string;
  readonly processGeneration?: string;
  readonly lifecycle: 'on-demand';
  readonly origin?: string;
}

interface PluginMiniAppGenerationLease {
  release(): Promise<boolean>;
}

interface PreparedPluginMiniAppTransition {
  readonly candidate: PluginMiniAppCandidate;
  readonly target: PluginMiniAppPublishedView;
  commit(): Promise<PluginMiniAppPublishedView>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

interface PreparedPluginMiniAppDisableTransition {
  readonly pluginId: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

interface PreparedPluginMiniAppStopTransition {
  readonly pluginId: string;
  readonly target: PluginMiniAppPublishedView;
  commit(): Promise<PluginMiniAppPublishedView>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

/** Minimal Host-owned adapter consumed by PluginSystem publication. */
export interface MiniAppPublicationSupervisor {
  prepare(
    candidate: PluginMiniAppCandidate,
    options?: { readonly forceStart?: boolean },
  ): Promise<PreparedPluginMiniAppTransition>;
  prepareDisable(pluginId: string): Promise<PreparedPluginMiniAppDisableTransition>;
  prepareStop(
    pluginId: string,
    options?: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  ): Promise<PreparedPluginMiniAppStopTransition>;
  acquire(input: {
    readonly pluginId: string;
    readonly expectedMiniAppGeneration?: string;
    readonly expectedProcessGeneration?: string;
  }): Promise<PluginMiniAppGenerationLease>;
  inspect(pluginId?: string): readonly {
    readonly pluginId: string;
    readonly phase: string;
    readonly active?: PluginMiniAppPublishedView;
  }[];
}

export interface MiniAppPublicationAttachment {
  readonly supervisor: MiniAppPublicationSupervisor;
}

interface MiniAppPublicationInput {
  readonly snapshot: PluginSnapshot;
  readonly currentSnapshot: PluginSnapshot;
  readonly buildContext?: MiniAppSnapshotBuildContext;
  readonly buildSnapshot: (
    input: PluginSnapshotBuildInputs,
    options: PluginSnapshotBuildOptions,
  ) => PluginSnapshot;
  readonly signal: AbortSignal;
  readonly requiredPluginId?: string;
  readonly forceRuntimePublicationPluginId?: string;
  readonly rosterSource?: PluginSnapshot;
}

export interface PreparedMiniAppPluginPublication {
  readonly snapshot: PluginSnapshot;
  readonly failClosed?: true;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

interface PreparedAcceptedMiniApp extends MiniAppDefinition {
  readonly target: PluginMiniAppPublishedView;
  readonly transition?: PreparedPluginMiniAppTransition;
  readonly stopTransition?: PreparedPluginMiniAppStopTransition;
  readonly mcpLease?: PluginMiniAppGenerationLease;
  readonly runtimeStopped?: true;
}

interface PreparedPublicationState {
  readonly previous: Map<string, PreparedAcceptedMiniApp>;
  readonly next: Map<string, PreparedAcceptedMiniApp>;
  readonly transitions: readonly PreparedPluginMiniAppTransition[];
  readonly disables: readonly PreparedPluginMiniAppDisableTransition[];
  readonly stops: readonly PreparedPluginMiniAppStopTransition[];
}

interface PrepareStateOptions {
  readonly forcedPluginId: string | undefined;
  readonly disablePluginIds: ReadonlySet<string>;
}

type LocalPluginProjection = PluginSnapshot['localPlugins'][number];

/** Adapts accepted MiniApp contributions to the ordinary Plugin publication transaction. */
export class SupervisedMiniAppPublicationParticipant {
  private active = new Map<string, PreparedAcceptedMiniApp>();
  private readonly buildContexts = new WeakMap<PluginSnapshot, MiniAppSnapshotBuildContext>();
  private closed = false;
  private stopRequest: { readonly pluginId: string; readonly signal?: AbortSignal } | undefined;

  constructor(private readonly options: { readonly supervisor: MiniAppPublicationSupervisor }) {}

  static recover(
    error: unknown,
    previous: PluginSnapshot,
    candidate: PluginSnapshot,
    current: PluginSnapshot,
  ): PluginSnapshot {
    return error instanceof PluginSystemError &&
      error.code === 'MINIAPP_PREPARATION_FAILED' &&
      current === candidate
      ? previous
      : current;
  }

  async prepare(input: MiniAppPublicationInput): Promise<PreparedMiniAppPluginPublication> {
    if (this.closed) throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
    throwIfAborted(input.signal);
    if (input.buildContext) this.recordBuildContext(input.snapshot, input.buildContext);
    const previous = this.active;
    const stopRequest = this.stopRequest;
    if (stopRequest) {
      this.stopRequest = undefined;
      return this.prepareStoppedPublication(input, previous, stopRequest);
    }
    const disablePluginIds = this.persistedDisableTargets(input);
    const failClosed =
      input.requiredPluginId !== undefined ||
      targetsMiniAppMutation(input.buildContext) ||
      changesOfficialMiniApp(input.currentSnapshot, input.snapshot, disablePluginIds);
    let state: PreparedPublicationState | undefined;
    try {
      const forcedPluginId = input.forceRuntimePublicationPluginId;
      const publicationSnapshot = this.runtimePublicationSnapshot(input, previous, forcedPluginId);
      const accepted = listAcceptedMiniApps(publicationSnapshot);
      assertAcceptedTargets(accepted, input.requiredPluginId, forcedPluginId);
      state = await this.prepareState(previous, accepted, input.signal, {
        forcedPluginId,
        disablePluginIds,
      });
      const rewritten = this.rewriteAcceptedSnapshot(
        publicationSnapshot,
        state.next,
        input.rosterSource ?? input.snapshot,
      );
      return this.preparedPublication(state, rewritten, { failClosed });
    } catch (error) {
      if (state) await ignoreFailure(rollbackState(state));
      if (failClosed) {
        throw normalizeSupervisedPreparationError(error);
      }
      const fallback = this.fallback(input, previous);
      return inactivePublication(fallback, () => {
        if (this.active !== previous) throw publicationError('PUBLICATION_SUPERSEDED');
      });
    }
  }

  async withStopRequest<T>(
    input: { readonly pluginId: string; readonly signal?: AbortSignal },
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
    if (this.stopRequest) throw publicationError('MINIAPP_STOP_ALREADY_PENDING');
    const request = {
      pluginId: input.pluginId,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    this.stopRequest = request;
    try {
      return await operation();
    } finally {
      if (this.stopRequest === request) this.stopRequest = undefined;
    }
  }

  hasPendingStopRequest(): boolean {
    return this.stopRequest !== undefined;
  }

  async recoverFailure(snapshot: PluginSnapshot): Promise<
    | {
        readonly candidateSnapshot: PluginSnapshot;
        readonly ownerFailureSnapshot: PluginSnapshot;
      }
    | undefined
  > {
    if (this.closed) throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
    const previous = this.active;
    const next = new Map(previous);
    const leases: PluginMiniAppGenerationLease[] = [];
    const stopped: PreparedAcceptedMiniApp[] = [];
    let changed = false;
    for (const [pluginId, item] of previous) {
      const status = this.options.supervisor
        .inspect(pluginId)
        .find((candidate) => candidate.pluginId === pluginId);
      if (acceptedRuntimeStillCurrent(status, item)) continue;
      if (stoppedRecoveryAlreadyProjected(snapshot, status, item)) continue;
      changed = true;
      if (item.mcpLease) leases.push(item.mcpLease);
      stopped.push(item);
      next.set(pluginId, stoppedAcceptedMiniApp(item, status?.active));
    }
    if (!changed) return undefined;
    if (this.active !== previous) throw publicationError('PUBLICATION_SUPERSEDED');
    this.active = next;
    await releaseRecoveryLeases(leases);
    return failureRecoveryPlan(
      snapshot,
      this.rewriteAcceptedSnapshot(snapshot, next, snapshot),
      stopped,
    );
  }

  private async prepareStoppedPublication(
    input: MiniAppPublicationInput,
    previous: Map<string, PreparedAcceptedMiniApp>,
    request: { readonly pluginId: string; readonly signal?: AbortSignal },
  ): Promise<PreparedMiniAppPluginPublication> {
    const accepted = previous.get(request.pluginId);
    if (!accepted) throw publicationError('MINIAPP_NOT_ACCEPTED');
    const authored = listAcceptedMiniApps(input.snapshot).find(
      ({ candidate }) => candidate.pluginId === request.pluginId,
    );
    if (!authored || !sameMiniAppCandidate(authored.candidate, accepted.candidate)) {
      throw publicationError('MINIAPP_REQUIRED_TARGET_NOT_ACCEPTED');
    }
    throwIfAborted(input.signal);
    let stop: PreparedPluginMiniAppStopTransition | undefined;
    try {
      stop = await this.options.supervisor.prepareStop(request.pluginId, {
        signal: request.signal ?? input.signal,
      });
      throwIfAborted(input.signal);
      assertStoppedTarget(accepted, stop.target);
      const next = new Map(previous);
      next.set(request.pluginId, {
        ...accepted,
        target: stop.target,
        stopTransition: stop,
        mcpLease: undefined,
        runtimeStopped: true,
      });
      const state: PreparedPublicationState = {
        previous,
        next,
        transitions: [],
        disables: [],
        stops: [stop],
      };
      const rewritten = this.rewriteAcceptedSnapshot(
        input.snapshot,
        next,
        input.rosterSource ?? input.snapshot,
      );
      return this.preparedPublication(state, rewritten, { failClosed: true });
    } catch (error) {
      if (stop) await ignoreFailure(stop.rollback());
      throw normalizeSupervisedPreparationError(error);
    }
  }

  recordBuildContext(snapshot: PluginSnapshot, context: MiniAppSnapshotBuildContext): void {
    this.buildContexts.set(snapshot, context);
  }

  private runtimePublicationSnapshot(
    input: MiniAppPublicationInput,
    previous: ReadonlyMap<string, PreparedAcceptedMiniApp>,
    forcedPluginId: string | undefined,
  ): PluginSnapshot {
    const context = input.buildContext;
    if (!context) return input.snapshot;
    const requestedPluginId = forcedPluginId ?? input.requiredPluginId;
    const requestedTarget = requestedPluginId
      ? listEnabledMiniAppDefinitions(input.snapshot).find(
          ({ candidate }) => candidate.pluginId === requestedPluginId,
        )?.candidate
      : undefined;
    const buildContext = {
      input: buildSelectiveMiniAppInputs({
        available: context.input,
        availableSnapshot: input.snapshot,
        activePluginIds: new Set(previous.keys()),
        ...(requestedTarget ? { target: requestedTarget } : {}),
      }),
      options: context.options,
    };
    return this.buildRuntimeSnapshot(input, buildContext);
  }

  private persistedDisableTargets(input: MiniAppPublicationInput): ReadonlySet<string> {
    if (input.requiredPluginId || input.forceRuntimePublicationPluginId) return new Set();
    const enabledDefinitionIds = new Set(
      listEnabledMiniAppDefinitions(input.snapshot).map(({ candidate }) => candidate.pluginId),
    );
    return new Set(
      this.options.supervisor
        .inspect()
        .filter(
          ({ pluginId, phase }) =>
            phase !== 'inactive' && phase !== 'disabled' && !enabledDefinitionIds.has(pluginId),
        )
        .map(({ pluginId }) => pluginId),
    );
  }

  buildContext(snapshot: PluginSnapshot): MiniAppSnapshotBuildContext | undefined {
    return this.buildContexts.get(snapshot);
  }

  /** Reprojects a synchronous identity boundary through the currently accepted generations. */
  projectAcceptedSnapshot(
    snapshot: PluginSnapshot,
    rosterSource: PluginSnapshot = snapshot,
  ): PluginSnapshot {
    if (this.closed) throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
    if (snapshot.officialPackages.length > 0) {
      return this.rewriteAcceptedSnapshot(snapshot, this.active, rosterSource);
    }
    const visibleDefinitions = new Map(
      listEnabledMiniAppDefinitions(snapshot).map(({ candidate }) => [
        candidate.pluginId,
        candidate,
      ]),
    );
    const visibleAccepted = new Map(
      [...this.active].filter(([pluginId, item]) => {
        const candidate = visibleDefinitions.get(pluginId);
        return candidate && sameMiniAppCandidate(candidate, item.candidate);
      }),
    );
    const localRoster = {
      ...rosterSource,
      enabledPlugins: Object.freeze(
        rosterSource.enabledPlugins.filter(({ source }) => source !== 'OFFICIAL'),
      ),
      turnCapabilities: {
        ...rosterSource.turnCapabilities,
        plugins: Object.freeze(
          rosterSource.turnCapabilities.plugins.filter(({ source }) => source !== 'official'),
        ),
      },
    };
    // Keep this.active intact: the queued scope publication still owns root and lease retirement.
    return this.rewriteAcceptedSnapshot(snapshot, visibleAccepted, localRoster);
  }

  /** Confirms that the accepted projection still names the Supervisor's running generation. */
  isAcceptedCandidateRunning(candidate: PluginMiniAppCandidate): boolean {
    if (this.closed) throw publicationError('MINIAPP_PUBLICATION_PARTICIPANT_CLOSED');
    const accepted = this.active.get(candidate.pluginId);
    if (!accepted || !sameMiniAppCandidate(accepted.candidate, candidate)) return false;
    const status = this.options.supervisor
      .inspect(candidate.pluginId)
      .find(({ pluginId }) => pluginId === candidate.pluginId);
    return status?.phase === 'active' && sameRunningGeneration(status.active, accepted.target);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const active = this.active;
    this.active = new Map();
    await releaseLeases(
      [...active.values()].flatMap(({ mcpLease }) => (mcpLease ? [mcpLease] : [])),
    );
  }

  private fallback(
    input: MiniAppPublicationInput,
    accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
  ): PluginSnapshot {
    const context = input.buildContext;
    const rosterSource = input.rosterSource ?? input.snapshot;
    if (!context) {
      return this.rewriteAcceptedSnapshot(input.currentSnapshot, accepted, rosterSource);
    }
    if (
      accepted.size === 0 &&
      context.input.localPackages.every(({ plugin }) => plugin.miniapp === undefined) &&
      context.input.officialPackages.every(({ plugin }) => plugin.miniapp === undefined)
    ) {
      return this.rewriteAcceptedSnapshot(input.snapshot, accepted, rosterSource);
    }
    const definitions = new Map(
      [...accepted].map(([pluginId, item]) => [pluginId, item.candidate]),
    );
    const retention = { activePluginIds: new Set(accepted.keys()) };
    return this.rewriteAcceptedSnapshot(
      this.buildRuntimeSnapshot(input, {
        input: {
          ...context.input,
          // Official changes fail closed above. Unchanged cold packages must still
          // lose managed contributions when an unrelated local update falls back.
          officialPackages: context.input.officialPackages.map((candidate) =>
            retainRuntimeMiniAppContribution(candidate, definitions, retention)
              ? candidate
              : ordinaryPackageContribution(candidate),
          ),
          localPackages: mergeFallbackLocalPackages(
            context.input.localPackages,
            input.currentSnapshot,
            accepted,
          ),
        },
        options: context.options,
      }),
      accepted,
      rosterSource,
    );
  }

  private buildRuntimeSnapshot(
    input: Pick<MiniAppPublicationInput, 'buildSnapshot'>,
    context: MiniAppSnapshotBuildContext,
  ): PluginSnapshot {
    const snapshot = input.buildSnapshot(context.input, context.options);
    this.recordBuildContext(snapshot, context);
    return snapshot;
  }

  private rewriteAcceptedSnapshot(
    snapshot: PluginSnapshot,
    accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
    rosterSource: PluginSnapshot = snapshot,
  ): PluginSnapshot {
    const rewritten = rewriteManagedMcpServers(snapshot, accepted);
    const rosteredSnapshot = withEnabledPluginRoster(rewritten, rosterSource);
    const context = this.buildContexts.get(snapshot);
    if (context) this.recordBuildContext(rosteredSnapshot, context);
    return rosteredSnapshot;
  }

  private async prepareState(
    previous: Map<string, PreparedAcceptedMiniApp>,
    accepted: readonly MiniAppDefinition[],
    signal: AbortSignal,
    options: PrepareStateOptions,
  ): Promise<PreparedPublicationState> {
    const next = new Map<string, PreparedAcceptedMiniApp>();
    const transitions: PreparedPluginMiniAppTransition[] = [];
    const disables: PreparedPluginMiniAppDisableTransition[] = [];
    try {
      for (const item of accepted) {
        throwIfAborted(signal);
        const reusable = this.reusableActive(previous, item, options.forcedPluginId);
        if (reusable) {
          next.set(item.candidate.pluginId, reusable);
          continue;
        }
        const transition = await this.options.supervisor.prepare(
          item.candidate,
          supervisorPreparationOptions(item, options),
        );
        transitions.push(transition);
        throwIfAborted(signal);
        next.set(item.candidate.pluginId, {
          ...item,
          candidate: transition.candidate,
          target: transition.target,
          transition,
        });
      }
      const acceptedIds = new Set(accepted.map(({ candidate }) => candidate.pluginId));
      for (const pluginId of new Set([...previous.keys(), ...options.disablePluginIds])) {
        if (acceptedIds.has(pluginId)) continue;
        const disable = await this.options.supervisor.prepareDisable(pluginId);
        disables.push(disable);
        throwIfAborted(signal);
      }
      return { previous, next, transitions, disables, stops: [] };
    } catch (error) {
      await ignoreFailure(rollbackResources([...transitions, ...disables]));
      throw error;
    }
  }

  private reusableActive(
    previous: ReadonlyMap<string, PreparedAcceptedMiniApp>,
    item: MiniAppDefinition,
    forcedPluginId: string | undefined,
  ): PreparedAcceptedMiniApp | undefined {
    if (item.candidate.pluginId === forcedPluginId) return undefined;
    const current = previous.get(item.candidate.pluginId);
    return current && sameMiniAppCandidate(current.candidate, item.candidate) ? current : undefined;
  }

  private preparedPublication(
    state: PreparedPublicationState,
    snapshot: PluginSnapshot,
    options: { readonly failClosed: boolean },
  ): PreparedMiniAppPluginPublication {
    const previous = state.previous;
    let committed = false;
    let rolledBack = false;
    let retired: PreparedAcceptedMiniApp[] = [];
    return {
      snapshot,
      ...(options.failClosed ? { failClosed: true as const } : {}),
      commit: async () => {
        if (rolledBack) throw publicationError('MINIAPP_PUBLICATION_ROLLED_BACK');
        if (committed) return;
        if (this.active !== previous) throw publicationError('PUBLICATION_SUPERSEDED');
        const acquired: PluginMiniAppGenerationLease[] = [];
        try {
          for (const transition of state.transitions) await transition.commit();
          for (const disable of state.disables) await disable.commit();
          for (const stop of state.stops) await stop.commit();
          await acquireManagedMcpLeases(state.next, this.options.supervisor, acquired);
          retired = [...previous].flatMap(([pluginId, item]) =>
            state.next.get(pluginId) === item ? [] : [item],
          );
          this.active = state.next;
          committed = true;
        } catch (error) {
          await ignoreFailure(releaseLeases([...acquired].reverse()));
          await ignoreFailure(rollbackState(state));
          throw error;
        }
      },
      rollback: async () => {
        if (rolledBack) return;
        rolledBack = true;
        const nextLeases = [...state.next.values()].flatMap(({ mcpLease }) =>
          mcpLease && !previousHasLease(previous, mcpLease) ? [mcpLease] : [],
        );
        const stoppedLeases = committed
          ? state.stops.flatMap(({ pluginId }) => {
              const lease = previous.get(pluginId)?.mcpLease;
              return lease ? [lease] : [];
            })
          : [];
        try {
          await runAllFinally([
            () => releaseLeases(nextLeases),
            () => rollbackState(state),
            () => releaseLeases(stoppedLeases),
          ]);
        } finally {
          if (committed) this.active = state.stops.length > 0 ? state.next : previous;
        }
      },
      finalize: async () => {
        if (!committed || rolledBack) return;
        await runAllFinally([
          ...state.transitions.map((transition) => () => transition.finalize()),
          ...state.disables.map((disable) => () => disable.finalize()),
          ...state.stops.map((stop) => () => stop.finalize()),
          () => releaseLeases(retired.flatMap(({ mcpLease }) => (mcpLease ? [mcpLease] : []))),
        ]);
      },
    };
  }
}

function supervisorPreparationOptions(
  item: MiniAppDefinition,
  options: PrepareStateOptions,
): { readonly forceStart: true } | undefined {
  const forceStart = item.candidate.pluginId === options.forcedPluginId;
  return forceStart ? { forceStart: true } : undefined;
}

export function attachSupervisedMiniAppPublication(input: {
  readonly current: SupervisedMiniAppPublicationParticipant | undefined;
  readonly initializeStarted: boolean;
  readonly supervisor: MiniAppPublicationSupervisor;
}): SupervisedMiniAppPublicationParticipant {
  if (input.initializeStarted) {
    throw new PluginSystemError(
      'PUBLICATION_PARTICIPANT_LATE',
      'Plugin publication participant must be attached before initialization',
    );
  }
  if (input.current) {
    throw new PluginSystemError(
      'PUBLICATION_PARTICIPANT_ALREADY_ATTACHED',
      'Plugin publication participant is already attached',
    );
  }
  return new SupervisedMiniAppPublicationParticipant({ supervisor: input.supervisor });
}

async function acquireManagedMcpLeases(
  next: Map<string, PreparedAcceptedMiniApp>,
  supervisor: MiniAppPublicationSupervisor,
  acquired: PluginMiniAppGenerationLease[],
): Promise<void> {
  for (const [pluginId, item] of next) {
    if (
      !item.transition ||
      item.runtimeStopped ||
      item.mcpLease ||
      item.candidate.mcpEndpoints.length === 0
    ) {
      continue;
    }
    const lease = await supervisor.acquire({
      pluginId,
      expectedMiniAppGeneration: item.target.miniAppGeneration,
      ...(item.target.processGeneration
        ? { expectedProcessGeneration: item.target.processGeneration }
        : {}),
    });
    acquired.push(lease);
    next.set(pluginId, { ...item, mcpLease: lease });
  }
}

/**
 * Rebuilds one coherent input set: candidate ordinary capabilities are current,
 * while only the last-accepted MiniApp contribution and managed MCP endpoint remain.
 */
function mergeFallbackLocalPackages(
  candidates: readonly PackageInput[],
  currentSnapshot: PluginSnapshot,
  accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
): readonly PackageInput[] {
  const currentMiniApps = currentAcceptedMiniAppProjections(currentSnapshot, accepted);
  const consumed = new Set<string>();
  const merged: PackageInput[] = [];

  for (const candidate of candidates) {
    const current = currentMiniApps.get(candidate.plugin.name);
    const ordinary = ordinaryPackageContribution(candidate);
    if (!current) {
      merged.push(ordinary);
      continue;
    }
    const combined = mergeOrdinaryWithAcceptedMiniApp(ordinary, current);
    merged.push(
      current.rootPath === candidate.plugin.rootPath
        ? combined
        : retainAcceptedPackageIdentity(combined, current),
    );
    consumed.add(current.name);
  }

  for (const current of currentMiniApps.values()) {
    if (!consumed.has(current.name)) merged.push(acceptedMiniAppContribution(current));
  }
  return merged;
}

function retainAcceptedPackageIdentity(
  merged: PackageInput,
  current: LocalPluginProjection,
): PackageInput {
  return {
    ...merged,
    plugin: {
      ...merged.plugin,
      // Candidate ordinary capabilities remain current, but a replacement root
      // cannot inherit the accepted Host service identity or name reservation.
      rootPath: current.plugin.rootPath,
      manifestPath: current.plugin.manifestPath,
    },
  };
}

function currentAcceptedMiniAppProjections(
  snapshot: PluginSnapshot,
  accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
): ReadonlyMap<string, LocalPluginProjection> {
  const projections = new Map<string, LocalPluginProjection>();
  for (const projection of snapshot.localPlugins) {
    const expected = accepted.get(projection.name);
    if (!expected || !projection.enabled || !projection.plugin.miniapp) continue;
    const candidate = miniAppCandidateFromPackage({
      plugin: projection.plugin,
    });
    if (sameMiniAppCandidate(candidate, expected.candidate)) {
      projections.set(projection.name, projection);
    }
  }
  return projections;
}

function mergeOrdinaryWithAcceptedMiniApp(
  ordinary: PackageInput,
  current: LocalPluginProjection,
): PackageInput {
  const miniapp = current.plugin.miniapp;
  if (!miniapp) return ordinary;
  const managedServers = miniAppManagedServerNames(miniapp);
  const acceptedServers = current.plugin.mcpServers.filter((server) =>
    managedServers.has(server.name),
  );
  return {
    ...ordinary,
    plugin: {
      ...ordinary.plugin,
      mcpServers: [
        ...ordinary.plugin.mcpServers.filter((server) => !managedServers.has(server.name)),
        ...acceptedServers,
      ],
      miniapp,
    },
  };
}

function acceptedMiniAppContribution(current: LocalPluginProjection): PackageInput {
  const miniapp = current.plugin.miniapp;
  if (!miniapp) return { plugin: current.plugin, contentDigest: current.contentDigest };
  const managedServers = miniAppManagedServerNames(miniapp);
  return {
    contentDigest: current.contentDigest,
    plugin: {
      ...current.plugin,
      apps: [],
      skills: [],
      mcpServers: current.plugin.mcpServers.filter((server) => managedServers.has(server.name)),
    },
  };
}

function assertAcceptedTargets(
  accepted: readonly MiniAppDefinition[],
  requiredPluginId: string | undefined,
  forcedPluginId: string | undefined,
): void {
  const acceptedIds = new Set(accepted.map(({ candidate }) => candidate.pluginId));
  if (requiredPluginId && !acceptedIds.has(requiredPluginId)) {
    throw publicationError('MINIAPP_REQUIRED_TARGET_NOT_ACCEPTED');
  }
  if (forcedPluginId && !acceptedIds.has(forcedPluginId)) {
    throw publicationError('MINIAPP_FORCE_TARGET_NOT_ACCEPTED');
  }
}

function targetsMiniAppMutation(context: MiniAppSnapshotBuildContext | undefined): boolean {
  return (
    context?.input.localPackages.some(
      ({ plugin }) =>
        plugin.miniapp !== undefined &&
        (context.options.localEnabledOverrides?.has(plugin.rootPath) === true ||
          context.options.excludedLocalRoots?.has(plugin.rootPath) === true),
    ) === true
  );
}

function changesOfficialMiniApp(
  current: PluginSnapshot,
  next: PluginSnapshot,
  disablePluginIds: ReadonlySet<string>,
): boolean {
  const previousPackages = new Map(current.officialPackages.map((entry) => [entry.name, entry]));
  const nextPackages = new Map(next.officialPackages.map((entry) => [entry.name, entry]));
  return [...previousPackages.keys(), ...nextPackages.keys()].some((name) => {
    const previous = previousPackages.get(name);
    const candidate = nextPackages.get(name);
    if (!previous?.plugin?.miniapp && !candidate?.plugin?.miniapp && !disablePluginIds.has(name)) {
      return false;
    }
    return (
      !previous ||
      !candidate ||
      previous.rootPath !== candidate.rootPath ||
      previous.contentDigest !== candidate.contentDigest ||
      Boolean(
        previous.plugin?.miniapp &&
        candidate.plugin?.miniapp &&
        !sameMiniAppCandidate(
          miniAppCandidateFromPackage({ plugin: previous.plugin }),
          miniAppCandidateFromPackage({ plugin: candidate.plugin }),
        ),
      )
    );
  });
}

function inactivePublication(
  snapshot: PluginSnapshot,
  assertCurrent: () => void = () => undefined,
): PreparedMiniAppPluginPublication {
  return {
    snapshot,
    commit: async () => assertCurrent(),
    rollback: async () => undefined,
    finalize: async () => undefined,
  };
}

function rewriteManagedMcpServers(
  snapshot: PluginSnapshot,
  accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
): PluginSnapshot {
  const replacements = managedReplacements(accepted);
  const expected = managedEndpointKeys(accepted);
  const used = new Set<string>();
  const mcpServers = snapshot.mcpServers.flatMap((entry) => {
    const key = managedKey(entry.pluginName, entry.server.name);
    const replacement = replacements.get(key);
    if (!replacement) {
      if (!expected.has(key)) return [entry];
      used.add(key);
      return [];
    }
    used.add(key);
    const transport = {
      type: 'http' as const,
      url: new URL(replacement.path, replacement.origin).toString(),
    };
    const rewritten: PluginSnapshotMcpServer = {
      ...entry,
      managedIdentity: {
        kind: 'miniapp',
        endpointId: replacement.endpointId,
        miniAppGeneration: replacement.miniAppGeneration,
        processGeneration: replacement.processGeneration,
      },
      server: {
        ...entry.server,
        resolvedServer: { ...entry.server.resolvedServer, transport },
        configJson: JSON.stringify(transport),
      },
    };
    return [rewritten];
  });
  if (used.size !== expected.size) throw publicationError('MINIAPP_MCP_SERVER_MISSING');
  return Object.freeze({ ...snapshot, mcpServers: Object.freeze(mcpServers) });
}

interface ManagedReplacement {
  readonly endpointId: string;
  readonly path: string;
  readonly origin: string;
  readonly miniAppGeneration: string;
  readonly processGeneration: string;
}

function managedReplacements(
  accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
): ReadonlyMap<string, ManagedReplacement> {
  const replacements = new Map<string, ManagedReplacement>();
  for (const [pluginId, item] of accepted) {
    if (item.candidate.mcpEndpoints.length === 0) continue;
    const origin = item.target.origin;
    const processGeneration = item.target.processGeneration;
    if (!origin || !processGeneration) {
      if (item.runtimeStopped) continue;
      throw publicationError('MINIAPP_MCP_RUNTIME_NOT_READY');
    }
    for (const declaration of item.candidate.mcpEndpoints) {
      replacements.set(managedKey(pluginId, declaration.id), {
        endpointId: declaration.id,
        path: declaration.path,
        origin,
        miniAppGeneration: item.target.miniAppGeneration,
        processGeneration,
      });
    }
  }
  return replacements;
}

function managedEndpointKeys(
  accepted: ReadonlyMap<string, PreparedAcceptedMiniApp>,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [pluginId, item] of accepted) {
    for (const declaration of item.candidate.mcpEndpoints) {
      keys.add(managedKey(pluginId, declaration.id));
    }
  }
  return keys;
}

function managedKey(pluginId: string, serverName: string): string {
  return `${pluginId}\0${serverName}`;
}

function failureRecoveryPlan(
  published: PluginSnapshot,
  candidate: PluginSnapshot,
  stopped: readonly PreparedAcceptedMiniApp[],
): {
  readonly candidateSnapshot: PluginSnapshot;
  readonly ownerFailureSnapshot: PluginSnapshot;
} {
  const stoppedByPlugin = new Map(stopped.map((item) => [item.candidate.pluginId, item]));
  const removedServers = published.mcpServers.filter((entry) => {
    const item = stoppedByPlugin.get(entry.pluginName);
    if (!item || !entry.managedIdentity) return false;
    const endpointIds = new Set(item.candidate.mcpEndpoints.map(({ id }) => id));
    return (
      endpointIds.has(entry.managedIdentity.endpointId) &&
      entry.managedIdentity.miniAppGeneration === item.target.miniAppGeneration &&
      (!item.target.processGeneration ||
        entry.managedIdentity.processGeneration === item.target.processGeneration)
    );
  });
  const removedServerKeys = new Set(
    removedServers.map(({ pluginName, server }) => managedKey(pluginName, server.name)),
  );
  const removedBindings = new Set(
    published.turnCapabilities.runtimeToolBindings.filter(
      (binding) =>
        binding.kind === 'mcp' &&
        binding.pluginName !== undefined &&
        removedServerKeys.has(managedKey(binding.pluginName, binding.source)),
    ),
  );
  const removedTools = new Set([...removedBindings].map(({ tool }) => tool));
  const exactCandidate = Object.freeze({
    ...candidate,
    mcpServers: Object.freeze(
      published.mcpServers.filter((entry) => !removedServers.includes(entry)),
    ),
  });
  return {
    candidateSnapshot: exactCandidate,
    ownerFailureSnapshot: withPluginMcpRuntime(
      exactCandidate,
      published.turnCapabilities.runtimeTools.filter((tool) => !removedTools.has(tool)),
      published.turnCapabilities.runtimeToolBindings.filter(
        (binding) => !removedBindings.has(binding),
      ),
      [],
    ),
  };
}

function snapshotHasManagedEndpoint(
  snapshot: PluginSnapshot,
  item: PreparedAcceptedMiniApp,
): boolean {
  const names = new Set(item.candidate.mcpEndpoints.map(({ id }) => id));
  return snapshot.mcpServers.some(
    ({ pluginName, server }) => pluginName === item.candidate.pluginId && names.has(server.name),
  );
}

function acceptedRuntimeStillCurrent(
  status: ReturnType<MiniAppPublicationSupervisor['inspect']>[number] | undefined,
  item: PreparedAcceptedMiniApp,
): boolean {
  return status?.phase === 'active' && sameRunningGeneration(status.active, item.target);
}

function stoppedRecoveryAlreadyProjected(
  snapshot: PluginSnapshot,
  status: ReturnType<MiniAppPublicationSupervisor['inspect']>[number] | undefined,
  item: PreparedAcceptedMiniApp,
): boolean {
  return Boolean(
    item.runtimeStopped &&
    status?.phase !== 'active' &&
    !snapshotHasManagedEndpoint(snapshot, item),
  );
}

function sameRunningGeneration(
  current: PluginMiniAppPublishedView | undefined,
  accepted: PluginMiniAppPublishedView,
): boolean {
  return Boolean(
    current?.processGeneration &&
    accepted.processGeneration &&
    current.pluginId === accepted.pluginId &&
    current.miniAppGeneration === accepted.miniAppGeneration &&
    current.processGeneration === accepted.processGeneration,
  );
}

function previousHasLease(
  previous: ReadonlyMap<string, PreparedAcceptedMiniApp>,
  lease: PluginMiniAppGenerationLease,
): boolean {
  return [...previous.values()].some((item) => item.mcpLease === lease);
}

async function rollbackState(state: PreparedPublicationState): Promise<void> {
  await rollbackResources([...state.transitions, ...state.disables, ...state.stops]);
}

async function rollbackResources(
  resources: readonly (
    | PreparedPluginMiniAppTransition
    | PreparedPluginMiniAppDisableTransition
    | PreparedPluginMiniAppStopTransition
  )[],
): Promise<void> {
  await runAllFinally([...resources].reverse().map((resource) => () => resource.rollback()));
}

function assertStoppedTarget(
  accepted: PreparedAcceptedMiniApp,
  target: PluginMiniAppPublishedView,
): void {
  if (
    target.pluginId === accepted.candidate.pluginId &&
    target.packageRoot === accepted.candidate.packageRoot &&
    target.packageDigest === accepted.candidate.packageDigest &&
    target.clientDigest === accepted.candidate.clientDigest &&
    target.surfacePath === accepted.candidate.surfacePath &&
    target.nodeDigest === accepted.candidate.nodeDigest &&
    target.lifecycle === accepted.candidate.lifecycle &&
    !target.processGeneration &&
    !target.origin
  ) {
    return;
  }
  throw publicationError('MINIAPP_STOP_TARGET_INVALID');
}

async function releaseLeases(leases: readonly PluginMiniAppGenerationLease[]): Promise<void> {
  await runAllFinally(leases.map((lease) => () => lease.release()));
}

async function releaseRecoveryLeases(
  leases: readonly PluginMiniAppGenerationLease[],
): Promise<void> {
  for (const lease of leases) await ignoreFailure(lease.release());
}

function stoppedAcceptedMiniApp(
  item: PreparedAcceptedMiniApp,
  observed: PluginMiniAppPublishedView | undefined,
): PreparedAcceptedMiniApp {
  return {
    source: item.source,
    ...(item.displayName ? { displayName: item.displayName } : {}),
    ...(item.description ? { description: item.description } : {}),
    ...(item.iconPath ? { iconPath: item.iconPath } : {}),
    candidate: item.candidate,
    runtimeStopped: true,
    target: {
      pluginId: item.candidate.pluginId,
      miniAppGeneration: observed?.miniAppGeneration ?? item.target.miniAppGeneration,
      packageRoot: item.candidate.packageRoot,
      packageDigest: item.candidate.packageDigest,
      clientDigest: item.candidate.clientDigest,
      surfacePath: item.candidate.surfacePath,
      nodeDigest: item.candidate.nodeDigest,
      lifecycle: item.candidate.lifecycle,
    },
  };
}

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // Preserve the primary preparation or publication failure after cleanup.
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : publicationError('DISPOSED');
}

function publicationError(code: string): PluginSystemError {
  return new PluginSystemError(code, 'Mini App publication preparation failed');
}

function supervisedPreparationReasonCode(error: unknown): string | undefined {
  return error instanceof PluginSystemError
    ? (error.reasonCode ?? error.code)
    : miniAppFailureReasonCode(error);
}

export function normalizeSupervisedPreparationError(error: unknown): PluginSystemError {
  if (isSupervisedBusyError(error)) {
    return new PluginSystemError('BUSY', 'Mini App operation is busy', { cause: error });
  }
  const reasonCode = supervisedPreparationReasonCode(error);
  return new PluginSystemError(
    'MINIAPP_PREPARATION_FAILED',
    'Mini App publication preparation failed',
    { cause: error, ...(reasonCode ? { reasonCode } : {}) },
  );
}

export function isSupervisedBusyError(error: unknown): boolean {
  return miniAppBusyReason(error) !== undefined;
}
