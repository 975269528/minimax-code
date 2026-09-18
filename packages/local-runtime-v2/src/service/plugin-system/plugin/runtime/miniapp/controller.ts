import {
  normalizeMiniAppPreparationError,
  type PendingPluginPublication,
  type PluginPublicationOptions,
  type PreparedPluginPublication,
} from '../../../publication.js';
import type {
  AvailableMiniAppDefinition,
  PluginSnapshotBuildInputs,
  PluginSnapshotBuildOptions,
  WorkspaceMiniAppInitializationResult,
} from '../../../contracts.js';
import { PluginSystemError } from '../../../errors.js';
import { deferred, ignoreFailure } from '../../../plugin-system-helpers.js';
import { PluginNameReservation } from '../../import/plugin-name-reservation.js';
import type { PluginPackageStorage } from '../package-storage.js';
import { buildPluginSnapshotFromInputs } from '../snapshot-inputs.js';
import type {
  PluginCapabilityReservations,
  PluginSnapshot,
  PluginSnapshotBuilder,
} from '../snapshot-builder.js';
import { activateAvailableMiniApp, type MiniAppActivationInput } from './activation.js';
import {
  listEnabledMiniAppDefinitions,
  listAcceptedMiniApps,
  miniAppCandidateFromPackage,
  sameMiniAppCandidate,
  type AcceptedMiniApp,
  type PluginMiniAppCandidate,
} from './candidate.js';
import {
  attachSupervisedMiniAppPublication,
  isSupervisedBusyError,
  normalizeSupervisedPreparationError,
  type MiniAppPublicationAttachment,
  SupervisedMiniAppPublicationParticipant,
} from './publication.js';
import { projectColdMiniAppPublication, type MiniAppSnapshotBuildContext } from './projection.js';
import { restartSupervisedMiniAppPublication, type MiniAppRestartInput } from './restart.js';

interface PluginMiniAppPublicationHost {
  readonly currentSnapshot: PluginSnapshot;
  initialize(): Promise<void>;
  assertUsable(): void;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/** Owns the MiniApp-specific facade while PluginSystem retains the generic transaction. */
export class PluginMiniAppPublicationController {
  private participantValue: SupervisedMiniAppPublicationParticipant | undefined;
  private readonly buildContexts = new WeakMap<PluginSnapshot, MiniAppSnapshotBuildContext>();

  constructor(
    private readonly options: {
      readonly host: PluginMiniAppPublicationHost;
      readonly packageStorage: Pick<
        PluginPackageStorage,
        | 'initializeWorkspaceMiniApp'
        | 'materializeMiniAppRuntimePackage'
        | 'readLocalMiniAppPackageRoot'
        | 'scanLocalPackages'
        | 'stageWorkspaceMiniAppCandidate'
      >;
      readonly builder: PluginSnapshotBuilder;
      readonly isLocalEnabled: (root: string) => boolean;
      readonly recordReservations: (
        snapshot: PluginSnapshot,
        reservations: PluginCapabilityReservations,
      ) => void;
      readonly initializeStarted: () => boolean;
      readonly isDisposed: () => boolean;
      readonly getDesiredSnapshot: () => PluginSnapshot;
      readonly setDesiredSnapshot: (snapshot: PluginSnapshot) => void;
      readonly preparePublication: (
        snapshot: PluginSnapshot,
        options: PluginPublicationOptions,
      ) => Promise<PendingPluginPublication>;
      readonly queuePublication: (publication: PendingPluginPublication) => void;
      readonly readAvailableSnapshot: () => Promise<PluginSnapshot>;
      readonly readOfficialInstallations: () => Promise<
        readonly { readonly name: string; readonly installed: boolean }[]
      >;
      readonly readSnapshotBuildInputs: () => Promise<PluginSnapshotBuildInputs>;
      readonly recordLocalMutation: () => void;
    },
  ) {
    this.nameReservation = new PluginNameReservation({
      readOfficialInstallations: options.readOfficialInstallations,
      readLocalPackages: () => options.packageStorage.scanLocalPackages(),
      isLocalEnabled: options.isLocalEnabled,
    });
  }

  private readonly nameReservation: PluginNameReservation;

  get participant(): SupervisedMiniAppPublicationParticipant | undefined {
    return this.participantValue;
  }

  attach(input: MiniAppPublicationAttachment): void {
    this.participantValue = attachSupervisedMiniAppPublication({
      current: this.participantValue,
      initializeStarted: this.options.initializeStarted(),
      supervisor: input.supervisor,
    });
  }

  async restart(input: MiniAppRestartInput): Promise<void> {
    this.requireParticipant();
    const host = this.options.host;
    await restartSupervisedMiniAppPublication(input, {
      initialize: () => host.initialize(),
      assertUsable: () => host.assertUsable(),
      runExclusive: (operation) => host.runExclusive(operation),
      currentSnapshot: () => host.currentSnapshot,
      setDesiredSnapshot: this.options.setDesiredSnapshot,
      prepare: (snapshot, options) => this.prepareSnapshotPublication(snapshot, options),
    });
  }

  listAcceptedMiniApps(): readonly AcceptedMiniApp[] {
    return listAcceptedMiniApps(this.options.host.currentSnapshot);
  }

  isAcceptedMiniAppRunning(pluginId: string): boolean {
    const accepted = this.listAcceptedMiniApps().find(
      ({ candidate }) => candidate.pluginId === pluginId,
    );
    return accepted
      ? (this.participantValue?.isAcceptedCandidateRunning(accepted.candidate) ?? false)
      : false;
  }

  materializeRuntimePackage(input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
  }): Promise<void> {
    return this.options.packageStorage.materializeMiniAppRuntimePackage(input);
  }

  async initializeWorkspace(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceMiniAppInitializationResult> {
    const host = this.options.host;
    await host.initialize();
    host.assertUsable();
    return host.runExclusive(async () => {
      throwIfAborted(input.signal);
      await this.nameReservation.assertAvailable(input.pluginId, {
        allowEnabledMiniAppUpdate: true,
      });
      throwIfAborted(input.signal);
      return this.options.packageStorage.initializeWorkspaceMiniApp(input);
    });
  }

  async publishWorkspace(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly sourcePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<AcceptedMiniApp> {
    const host = this.options.host;
    await host.initialize();
    host.assertUsable();
    return host.runExclusive(async () => {
      throwIfAborted(input.signal);
      await this.nameReservation.assertAvailable(input.pluginId, {
        allowEnabledMiniAppUpdate: true,
      });
      throwIfAborted(input.signal);
      const transaction = await this.options.packageStorage.stageWorkspaceMiniAppCandidate(input);
      try {
        throwIfAborted(input.signal);
        await transaction.install();
        throwIfAborted(input.signal);
        const inputs = await this.options.readSnapshotBuildInputs();
        const installed = inputs.localPackages.find(({ plugin }) => plugin.name === input.pluginId);
        if (!installed?.plugin.miniapp || installed.contentDigest !== transaction.contentDigest) {
          throw new PluginSystemError(
            'MINIAPP_PREPARATION_FAILED',
            'installed MiniApp candidate identity changed',
            { reasonCode: 'CANDIDATE_CHANGED' },
          );
        }
        const next = this.buildPublicationSnapshot(inputs, {});
        const projection = next.localPlugins.find(({ name }) => name === input.pluginId);
        if (!projection?.enabled) {
          throw new PluginSystemError('PLUGIN_NOT_ENABLED', 'Mini App Plugin is disabled');
        }
        const completion = deferred<void>();
        await this.prepareSnapshotPublication(next, {
          completion,
          requiredMiniAppPluginId: input.pluginId,
          forceRuntimePublicationPluginId: input.pluginId,
          ...(input.signal ? { signal: input.signal } : {}),
          commit: async () => throwIfAborted(input.signal),
          rollback: transaction.rollback,
          finalize: transaction.finalize,
          cancel: transaction.rollback,
        });
        this.options.recordLocalMutation();
        const accepted = this.listAcceptedMiniApps().find(
          ({ candidate }) => candidate.pluginId === input.pluginId,
        );
        if (accepted) return accepted;
        throw new PluginSystemError(
          'MINIAPP_PREPARATION_FAILED',
          'Mini App publication was not accepted',
          { reasonCode: 'PUBLICATION_NOT_ACCEPTED' },
        );
      } catch (error) {
        await ignoreFailure(transaction.rollback());
        throw error;
      }
    });
  }

  async stop(input: { readonly pluginId: string; readonly signal?: AbortSignal }): Promise<void> {
    const participant = this.requireParticipant();
    const host = this.options.host;
    await host.initialize();
    host.assertUsable();
    await host.runExclusive(async () => {
      throwIfAborted(input.signal);
      const current = host.currentSnapshot;
      if (
        !this.listAcceptedMiniApps().some(({ candidate }) => candidate.pluginId === input.pluginId)
      ) {
        throw new PluginSystemError('MINIAPP_NOT_ACCEPTED', 'Mini App definition is not accepted');
      }
      const completion = deferred<void>();
      await participant.withStopRequest(input, () =>
        this.prepareSnapshotPublication(current, {
          completion,
          requiredMiniAppPluginId: input.pluginId,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    });
  }

  async listAvailableMiniApps(): Promise<readonly AvailableMiniAppDefinition[]> {
    await this.options.host.initialize();
    this.options.host.assertUsable();
    return this.options.host.runExclusive(async () =>
      listEnabledMiniAppDefinitions(await this.options.readAvailableSnapshot()).map(
        ({ candidate, ...metadata }) => ({ pluginId: candidate.pluginId, ...metadata }),
      ),
    );
  }

  async activate(input: MiniAppActivationInput): Promise<void> {
    const participant = this.requireParticipant();
    const host = this.options.host;
    await activateAvailableMiniApp(input, {
      initialize: () => host.initialize(),
      assertUsable: () => host.assertUsable(),
      runExclusive: (operation) => host.runExclusive(operation),
      readAvailableSnapshot: this.options.readAvailableSnapshot,
      isAcceptedCandidateRunning: (candidate) => participant.isAcceptedCandidateRunning(candidate),
      buildContext: (snapshot) => this.buildContext(snapshot),
      currentSnapshot: () => host.currentSnapshot,
      setDesiredSnapshot: this.options.setDesiredSnapshot,
      buildSnapshot: (snapshotInput, buildOptions) =>
        this.buildPublicationSnapshot(snapshotInput, buildOptions),
      prepare: (snapshot, publicationOptions) =>
        this.prepareSnapshotPublication(snapshot, publicationOptions),
    });
  }

  async prepareSnapshotPublication(
    candidate: PluginSnapshot,
    options: PluginPublicationOptions = {},
  ): Promise<void> {
    const previous = this.options.getDesiredSnapshot();
    this.options.setDesiredSnapshot(candidate);
    try {
      this.options.queuePublication(await this.options.preparePublication(candidate, options));
      await options.completion?.promise;
    } catch (error) {
      this.options.setDesiredSnapshot(
        this.recover(error, previous, candidate, this.options.getDesiredSnapshot()),
      );
      throw error;
    }
  }

  async verifyCandidate(candidate: PluginMiniAppCandidate): Promise<boolean> {
    if (this.options.isDisposed()) return false;
    try {
      const packageEntry = await this.options.packageStorage.readLocalMiniAppPackageRoot(
        candidate.packageRoot,
      );
      return (
        packageEntry.plugin.rootPath === candidate.packageRoot &&
        packageEntry.plugin.name === candidate.pluginId &&
        sameMiniAppCandidate(miniAppCandidateFromPackage(packageEntry), candidate)
      );
    } catch {
      return false;
    }
  }

  recover(
    error: unknown,
    previous: PluginSnapshot,
    candidate: PluginSnapshot,
    current: PluginSnapshot,
  ): PluginSnapshot {
    return SupervisedMiniAppPublicationParticipant.recover(error, previous, candidate, current);
  }

  projectAcceptedSnapshot(snapshot: PluginSnapshot, rosterSource?: PluginSnapshot): PluginSnapshot {
    return this.participantValue?.projectAcceptedSnapshot(snapshot, rosterSource) ?? snapshot;
  }

  /** Removes cold runtime contributions when this Host has no Supervisor participant. */
  projectOrdinaryPublication(snapshot: PluginSnapshot): PluginSnapshot {
    if (this.participantValue || listEnabledMiniAppDefinitions(snapshot).length === 0) {
      return snapshot;
    }
    const buildContext = this.buildContext(snapshot);
    if (!buildContext) {
      throw new PluginSystemError(
        'MINIAPP_CATALOG_STALE',
        'Mini App definition catalog cannot be projected for publication',
      );
    }
    return projectColdMiniAppPublication({
      snapshot,
      buildContext,
      buildSnapshot: (input, options) => this.buildPublicationSnapshot(input, options),
    });
  }

  buildPublicationSnapshot(
    input: PluginSnapshotBuildInputs,
    options: PluginSnapshotBuildOptions,
  ): PluginSnapshot {
    const snapshot = buildPluginSnapshotFromInputs({
      builder: this.options.builder,
      snapshotInputs: input,
      buildOptions: options,
      isLocalEnabled: this.options.isLocalEnabled,
    });
    this.recordBuildContext(snapshot, { input, options });
    this.options.recordReservations(snapshot, input.reservations);
    return snapshot;
  }

  recordBuildContext(snapshot: PluginSnapshot, context: MiniAppSnapshotBuildContext): void {
    this.buildContexts.set(snapshot, context);
    this.participantValue?.recordBuildContext(snapshot, context);
  }

  materializeBuildContext(snapshot: PluginSnapshot, fallback?: PluginSnapshot): void {
    const context =
      this.buildContext(snapshot) ?? (fallback ? this.buildContext(fallback) : undefined);
    if (context) this.recordBuildContext(snapshot, context);
  }

  inheritBuildContext(source: PluginSnapshot, target: PluginSnapshot): void {
    const context = this.buildContext(source);
    if (context) this.recordBuildContext(target, context);
  }

  private buildContext(snapshot: PluginSnapshot): MiniAppSnapshotBuildContext | undefined {
    return this.participantValue?.buildContext(snapshot) ?? this.buildContexts.get(snapshot);
  }

  private requireParticipant(): SupervisedMiniAppPublicationParticipant {
    if (this.participantValue) return this.participantValue;
    throw new PluginSystemError(
      'MINIAPP_PUBLICATION_NOT_ATTACHED',
      'Mini App publication participant is not attached',
    );
  }

  bindRestartCancellation(publication: PendingPluginPublication, removePending: () => void): void {
    publication.bindMiniAppRestartCancellation?.(removePending);
  }

  normalizePreparationError(
    error: unknown,
    prepared: PreparedPluginPublication | undefined,
  ): unknown {
    if (isSupervisedBusyError(error)) {
      return normalizeSupervisedPreparationError(error);
    }
    return normalizeMiniAppPreparationError(error, prepared?.participant);
  }

  async close(): Promise<void> {
    await this.participantValue?.close();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Mini App action aborted');
  error.name = 'AbortError';
  throw error;
}
