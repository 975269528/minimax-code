import type { PluginSnapshotBuildInputs, PluginSnapshotBuildOptions } from './contracts.js';
import { PluginSystemError } from './errors.js';
import type { PluginMcpReconcileOptions, PluginMcpRuntimePort } from './mcp/runtime.js';
import { runAllFinally, settleInBackground } from './plugin-system-helpers.js';
import { listAcceptedMiniApps } from './plugin/runtime/miniapp/candidate.js';
import type {
  PreparedMiniAppPluginPublication,
  SupervisedMiniAppPublicationParticipant,
} from './plugin/runtime/miniapp/publication.js';
import type { PreparedOfficialPluginReconciliation } from './plugin/runtime/official-reconciler.js';
import { withPluginMcpRuntime, type PluginSnapshot } from './plugin/runtime/snapshot-builder.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

type PluginMcpInventoryMode = NonNullable<PluginMcpReconcileOptions['inventoryMode']>;

export interface PendingPluginPublication {
  readonly scopeKey: string;
  readonly prepare: () => Promise<PreparedPluginPublication>;
  readonly completion?: Deferred<void>;
  readonly cancel?: () => Promise<void>;
  readonly mcpDiscovery?: PluginMcpDiscoveryPublication;
  readonly recoverFailure?: (
    currentSnapshot: PluginSnapshot,
  ) => Promise<PluginPublicationFailureRecovery | undefined>;
  readonly bindMiniAppRestartCancellation?: (removePending: () => void) => void;
}

interface PluginPublicationFailureRecovery {
  readonly candidateSnapshot: PluginSnapshot;
  readonly ownerFailureSnapshot: PluginSnapshot;
}

export interface PreparedPluginPublication {
  readonly snapshot: PluginSnapshot;
  /** Exact snapshot cloned to produce `snapshot`, when publication enriches it with MCP runtime. */
  readonly snapshotSource: PluginSnapshot;
  readonly preparedRuntime?: PluginMcpRuntimePort;
  readonly participant?: PreparedMiniAppPluginPublication;
  readonly commit?: () => Promise<void>;
  readonly rollback?: () => Promise<void>;
  readonly finalize?: () => Promise<void>;
}

export async function completePluginPublication(
  started: Promise<void>,
  pending: PendingPluginPublication,
  onSettled: () => void,
): Promise<void> {
  try {
    await started;
  } catch (error) {
    pending.completion?.reject(error);
  } finally {
    onSettled();
  }
}

export interface PluginPublicationOptions {
  readonly completion?: Deferred<void>;
  readonly commit?: () => Promise<void>;
  readonly rollback?: () => Promise<void>;
  readonly finalize?: () => Promise<void>;
  readonly cancel?: () => Promise<void>;
  readonly mcpDiscovery?: PluginMcpDiscoveryPublication;
  readonly requiredMiniAppPluginId?: string;
  readonly forceRuntimePublicationPluginId?: string;
  readonly miniAppRosterSource?: PluginSnapshot;
  readonly signal?: AbortSignal;
}

interface PreparePluginPublicationInput {
  readonly snapshot: PluginSnapshot;
  readonly currentSnapshot: PluginSnapshot;
  readonly publicationScopeKey: string;
  readonly options: PluginPublicationOptions;
  readonly participant?: SupervisedMiniAppPublicationParticipant;
  readonly factory?: () => PluginMcpRuntimePort;
  readonly currentRuntime: PluginMcpRuntimePort;
  readonly inventoryMode: 'cached-only' | 'discover';
  readonly signal: AbortSignal;
  readonly buildSnapshot: (
    snapshotInputs: PluginSnapshotBuildInputs,
    buildOptions: PluginSnapshotBuildOptions,
  ) => PluginSnapshot;
  readonly isDisposed: () => boolean;
  readonly isSuperseded: () => boolean;
}

export async function preparePluginPublication(
  input: PreparePluginPublicationInput,
): Promise<{ readonly publication: PendingPluginPublication; readonly snapshot: PluginSnapshot }> {
  if (requiresLazyDestructivePreparation(input)) {
    return lazyDestructivePluginPublication(
      input as PreparePluginPublicationInput & {
        readonly participant: SupervisedMiniAppPublicationParticipant;
      },
    );
  }
  return preparePluginPublicationNow(input);
}

async function preparePluginPublicationNow(
  input: PreparePluginPublicationInput,
): Promise<{ readonly publication: PendingPluginPublication; readonly snapshot: PluginSnapshot }> {
  const participant = await prepareMiniAppPublicationParticipant(input);
  const snapshot = participant?.snapshot ?? input.snapshot;
  if (!input.factory) {
    return {
      snapshot,
      publication: currentRuntimePublication(
        snapshot,
        input.publicationScopeKey,
        input.options,
        participant,
      ),
    };
  }
  return prepareIsolatedPluginPublication({
    snapshot,
    publicationScopeKey: input.publicationScopeKey,
    options: input.options,
    ...(participant ? { participant } : {}),
    factory: input.factory,
    currentRuntime: input.currentRuntime,
    inventoryMode: input.inventoryMode,
    isDisposed: input.isDisposed,
    isSuperseded: input.isSuperseded,
  });
}

function requiresLazyDestructivePreparation(input: PreparePluginPublicationInput): boolean {
  return Boolean(
    input.participant &&
    (input.options.forceRuntimePublicationPluginId || input.participant.hasPendingStopRequest()),
  );
}

function lazyDestructivePluginPublication(
  input: PreparePluginPublicationInput & {
    readonly participant: SupervisedMiniAppPublicationParticipant;
  },
): { readonly publication: PendingPluginPublication; readonly snapshot: PluginSnapshot } {
  let preparedPublication: PendingPluginPublication | undefined;
  let mcpDiscovery: PluginMcpDiscoveryPublication | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= (async () => {
      await input.options.cancel?.();
    })();
    return cancellation;
  };
  const lazyInput = {
    ...input,
    options: { ...input.options, cancel },
  };
  const publication: PendingPluginPublication = {
    scopeKey: input.publicationScopeKey,
    ...(input.options.completion ? { completion: input.options.completion } : {}),
    get mcpDiscovery() {
      return mcpDiscovery;
    },
    recoverFailure: (currentSnapshot) => input.participant.recoverFailure(currentSnapshot),
    prepare: async () => {
      try {
        const prepared = await preparePluginPublicationNow(lazyInput);
        preparedPublication = prepared.publication;
        mcpDiscovery = preparedPublication.mcpDiscovery;
        return await preparedPublication.prepare();
      } catch (error) {
        if (preparedPublication) await ignoreFailure(preparedPublication.cancel?.());
        else await ignoreFailure(cancel());
        throw error;
      }
    },
    cancel: async () => {
      if (preparedPublication) await preparedPublication.cancel?.();
      else await cancel();
    },
  };
  return {
    snapshot: input.snapshot,
    publication: withMiniAppRestartCancellation(publication, lazyInput.options),
  };
}

async function prepareMiniAppPublicationParticipant(
  input: PreparePluginPublicationInput,
): Promise<PreparedMiniAppPluginPublication | undefined> {
  if (!shouldPrepareMiniAppParticipant(input) || !input.participant) return undefined;
  const buildContext = input.participant.buildContext(input.snapshot);
  return input.participant.prepare({
    snapshot: input.snapshot,
    currentSnapshot: input.currentSnapshot,
    ...(buildContext ? { buildContext } : {}),
    buildSnapshot: input.buildSnapshot,
    signal: input.options.signal ?? input.signal,
    ...(input.options.requiredMiniAppPluginId
      ? { requiredPluginId: input.options.requiredMiniAppPluginId }
      : {}),
    ...(input.options.forceRuntimePublicationPluginId
      ? { forceRuntimePublicationPluginId: input.options.forceRuntimePublicationPluginId }
      : {}),
    ...(input.options.miniAppRosterSource
      ? { rosterSource: input.options.miniAppRosterSource }
      : {}),
  });
}

export async function commitPreparedPluginPublication(
  prepared: PreparedPluginPublication,
): Promise<void> {
  await prepared.commit?.();
  await prepared.participant?.commit();
}

export async function rollbackPreparedPluginPublication(
  prepared: PreparedPluginPublication,
): Promise<void> {
  await runAllFinally([() => prepared.participant?.rollback(), () => prepared.rollback?.()]);
}

export function preparedPluginPublicationFinalizer(
  prepared: PreparedPluginPublication,
): (() => Promise<void>) | undefined {
  if (!prepared.finalize && !prepared.participant) return undefined;
  return () => runAllFinally([() => prepared.finalize?.(), () => prepared.participant?.finalize()]);
}

export function assertPluginPublicationFence(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new PluginSystemError('SCOPE_CHANGED', 'Plugin publication identity changed');
  }
}

export interface PluginMcpDiscoveryPublication {
  readonly snapshot: PluginSnapshot;
  readonly next: 'immediate' | 'retry' | 'complete';
}

function currentRuntimePublication(
  snapshot: PluginSnapshot,
  publicationScopeKey: string,
  options: PluginPublicationOptions,
  participant?: PreparedMiniAppPluginPublication,
): PendingPluginPublication {
  return withMiniAppRestartCancellation(
    {
      scopeKey: publicationScopeKey,
      ...(options.completion ? { completion: options.completion } : {}),
      ...(options.cancel || participant
        ? {
            cancel: async () => {
              await runAllFinallyIgnoringFailure([
                () => participant?.rollback(),
                () => options.cancel?.(),
              ]);
            },
          }
        : {}),
      prepare: async () => ({
        snapshot: participant?.snapshot ?? snapshot,
        snapshotSource: participant?.snapshot ?? snapshot,
        ...(participant ? { participant } : {}),
        ...(options.commit ? { commit: options.commit } : {}),
        ...(options.rollback ? { rollback: options.rollback } : {}),
        ...(options.finalize ? { finalize: options.finalize } : {}),
      }),
    },
    options,
  );
}

function isolatedRuntimePublication(input: {
  readonly snapshot: PluginSnapshot;
  readonly snapshotSource: PluginSnapshot;
  readonly publicationScopeKey: string;
  readonly runtime: PluginMcpRuntimePort;
  readonly options: PluginPublicationOptions;
  readonly participant?: PreparedMiniAppPluginPublication;
}): PendingPluginPublication {
  return withMiniAppRestartCancellation(
    {
      scopeKey: input.publicationScopeKey,
      ...(input.options.completion ? { completion: input.options.completion } : {}),
      ...(input.options.mcpDiscovery ? { mcpDiscovery: input.options.mcpDiscovery } : {}),
      cancel: async () => {
        await runAllFinallyIgnoringFailure([
          () => input.runtime.close(),
          () => input.participant?.rollback(),
          () => input.options.cancel?.(),
        ]);
      },
      prepare: async () => ({
        snapshot: input.snapshot,
        snapshotSource: input.snapshotSource,
        preparedRuntime: input.runtime,
        ...(input.participant ? { participant: input.participant } : {}),
        ...(input.options.commit ? { commit: input.options.commit } : {}),
        ...(input.options.rollback ? { rollback: input.options.rollback } : {}),
        ...(input.options.finalize ? { finalize: input.options.finalize } : {}),
      }),
    },
    input.options,
  );
}

async function prepareIsolatedPluginPublication(input: {
  readonly snapshot: PluginSnapshot;
  readonly publicationScopeKey: string;
  readonly options: PluginPublicationOptions;
  readonly participant?: PreparedMiniAppPluginPublication;
  readonly factory: () => PluginMcpRuntimePort;
  readonly currentRuntime: PluginMcpRuntimePort;
  readonly inventoryMode: 'cached-only' | 'discover';
  readonly isDisposed: () => boolean;
  readonly isSuperseded: () => boolean;
}): Promise<{ readonly publication: PendingPluginPublication; readonly snapshot: PluginSnapshot }> {
  let candidate: PluginMcpRuntimePort | undefined;
  try {
    candidate = requireMcpRuntime(input.factory);
    const snapshotSource = input.participant?.snapshot ?? input.snapshot;
    seedCandidateInventory(candidate, input.currentRuntime);
    const inventoryMode: PluginMcpInventoryMode =
      input.participant && input.inventoryMode === 'cached-only'
        ? 'discover-managed'
        : input.inventoryMode;
    const mcp = await candidate.reconcile(
      snapshotSource.mcpServers,
      reconcileOptions(inventoryMode),
    );
    assertNotAborted(input.options.signal);
    assertPublicationAvailable(input);
    const preparedSnapshot = withPluginMcpRuntime(
      snapshotSource,
      mcp.runtimeTools,
      mcp.runtimeToolBindings ?? [],
      mcp.diagnostics,
    );
    const discovery = mcpDiscoveryPublication(
      snapshotSource,
      inventoryMode,
      mcp.failedServerCount,
      mcp.diagnostics,
    );
    return {
      snapshot: preparedSnapshot,
      publication: isolatedRuntimePublication({
        snapshot: preparedSnapshot,
        snapshotSource,
        publicationScopeKey: input.publicationScopeKey,
        runtime: candidate,
        options: {
          ...input.options,
          ...(discovery ? { mcpDiscovery: discovery } : {}),
        },
        ...(input.participant ? { participant: input.participant } : {}),
      }),
    };
  } catch (error) {
    if (candidate || input.participant) {
      await cancelPreparedCandidate(candidate, input.options, input.participant);
    }
    throw normalizeMiniAppPreparationError(error, input.participant);
  }
}

/** Rebuilds a recovery generation without discovery, retry, or participant-specific projection. */
async function preparePluginPublicationRecovery(input: {
  readonly snapshot: PluginSnapshot;
  readonly snapshotSource: PluginSnapshot;
  readonly factory: () => PluginMcpRuntimePort;
  readonly currentRuntime: PluginMcpRuntimePort;
}): Promise<PreparedPluginPublication & { readonly preparedRuntime: PluginMcpRuntimePort }> {
  let runtime: PluginMcpRuntimePort | undefined;
  try {
    runtime = requireMcpRuntime(input.factory);
    seedCandidateInventory(runtime, input.currentRuntime);
    const mcp = await runtime.reconcile(input.snapshot.mcpServers, {
      inventoryMode: 'cached-only',
    });
    return {
      preparedRuntime: runtime,
      snapshot: withPluginMcpRuntime(
        input.snapshot,
        mcp.runtimeTools,
        mcp.runtimeToolBindings ?? [],
        mcp.diagnostics,
      ),
      snapshotSource: input.snapshotSource,
    };
  } catch (error) {
    await ignoreFailure(runtime?.close());
    throw error;
  }
}

export async function recoverDestructivePluginPublication(input: {
  readonly pending: PendingPluginPublication;
  readonly currentSnapshot: PluginSnapshot;
  readonly currentRuntime: PluginMcpRuntimePort;
  readonly factory?: () => PluginMcpRuntimePort;
  readonly adoptPrepared: (
    recovery: PreparedPluginPublication & { readonly preparedRuntime: PluginMcpRuntimePort },
  ) => Promise<void>;
  readonly adoptOwnerFailure: (snapshot: PluginSnapshot) => void;
}): Promise<boolean> {
  const plan = await input.pending.recoverFailure?.(input.currentSnapshot);
  if (!plan) return false;
  let recovery:
    | (PreparedPluginPublication & { readonly preparedRuntime: PluginMcpRuntimePort })
    | undefined;
  try {
    if (!input.factory) {
      throw new PluginSystemError(
        'MCP_RUNTIME_FACTORY_MISSING',
        'destructive Plugin publication recovery requires an MCP runtime factory',
      );
    }
    recovery = await preparePluginPublicationRecovery({
      snapshot: plan.candidateSnapshot,
      snapshotSource: input.currentSnapshot,
      factory: input.factory,
      currentRuntime: input.currentRuntime,
    });
  } catch {
    input.adoptOwnerFailure(plan.ownerFailureSnapshot);
    return true;
  }
  await input.adoptPrepared(recovery);
  return true;
}

export function throwRecoveredDestructivePublicationFailure(
  error: unknown,
  recovered: boolean,
): void {
  if (!recovered || !isPublicationSuperseded(error)) return;
  throw new PluginSystemError(
    'MINIAPP_PREPARATION_FAILED',
    'Mini App publication was superseded after destructive recovery',
    { cause: error, reasonCode: 'PUBLICATION_SUPERSEDED' },
  );
}

function assertPublicationAvailable(input: {
  readonly isDisposed: () => boolean;
  readonly isSuperseded: () => boolean;
}): void {
  const unavailable = publicationUnavailable(input);
  if (!unavailable) return;
  throw new PluginSystemError(
    unavailable === 'disposed' ? 'DISPOSED' : 'PUBLICATION_SUPERSEDED',
    unavailable === 'disposed' ? 'PluginSystem is disposed' : 'Plugin publication was superseded',
  );
}

function requireMcpRuntime(factory: () => PluginMcpRuntimePort): PluginMcpRuntimePort {
  const runtime = factory();
  if (runtime) return runtime;
  throw new PluginSystemError(
    'MCP_RUNTIME_FACTORY_INVALID',
    'Plugin MCP runtime factory did not create a runtime',
  );
}

function seedCandidateInventory(
  candidate: PluginMcpRuntimePort,
  current: PluginMcpRuntimePort,
): void {
  const currentInventory = current.exportInventory?.();
  if (currentInventory) candidate.importInventory?.(currentInventory);
}

function shouldPrepareMiniAppParticipant(input: {
  readonly snapshot: PluginSnapshot;
  readonly currentSnapshot: PluginSnapshot;
  readonly options: PluginPublicationOptions;
  readonly participant?: SupervisedMiniAppPublicationParticipant;
}): boolean {
  if (!input.participant) return false;
  if (input.options.requiredMiniAppPluginId || input.options.forceRuntimePublicationPluginId) {
    return true;
  }
  return (
    listAcceptedMiniApps(input.snapshot).length > 0 ||
    listAcceptedMiniApps(input.currentSnapshot).length > 0
  );
}

function withMiniAppRestartCancellation(
  publication: PendingPluginPublication,
  options: PluginPublicationOptions,
): PendingPluginPublication {
  const signal = options.signal;
  const completion = options.completion;
  if (!signal || !completion || !options.requiredMiniAppPluginId) return publication;
  let started = false;
  let cancelled = false;
  let removePending: () => void = () => undefined;
  const detach = () => signal.removeEventListener('abort', abort);
  const abort = () => {
    detach();
    if (started || cancelled) return;
    cancelled = true;
    removePending();
    settleInBackground(
      (async () => {
        await ignoreFailure(publication.cancel?.());
        completion.reject(abortReason(signal));
      })(),
    );
  };
  return {
    ...publication,
    get mcpDiscovery() {
      return publication.mcpDiscovery;
    },
    prepare: async () => {
      started = true;
      detach();
      assertNotAborted(signal);
      return publication.prepare();
    },
    cancel: async () => {
      cancelled = true;
      detach();
      await publication.cancel?.();
    },
    bindMiniAppRestartCancellation: (remove) => {
      removePending = remove;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    },
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new PluginSystemError('MINIAPP_PREPARATION_FAILED', 'aborted');
}

export function normalizeMiniAppPreparationError(
  error: unknown,
  participant: PreparedMiniAppPluginPublication | undefined,
): unknown {
  if (!participant?.failClosed || isPublicationBoundaryError(error)) return error;
  const reasonCode = ownerClassifiedReasonCode(error);
  return new PluginSystemError(
    'MINIAPP_PREPARATION_FAILED',
    'Mini App publication preparation failed',
    { cause: error, ...(reasonCode ? { reasonCode } : {}) },
  );
}

function ownerClassifiedReasonCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const fields = error as { readonly code?: unknown; readonly reasonCode?: unknown };
  if (typeof fields.reasonCode === 'string') return fields.reasonCode;
  return typeof fields.code === 'string' ? fields.code : undefined;
}

function isPublicationBoundaryError(error: unknown): boolean {
  return (
    error instanceof PluginSystemError &&
    (error.code === 'SCOPE_CHANGED' ||
      error.code === 'DISPOSED' ||
      error.code === 'PUBLICATION_SUPERSEDED')
  );
}

function reconcileOptions(inventoryMode: PluginMcpInventoryMode):
  | { readonly inventoryMode: 'cached-only' }
  | {
      readonly inventoryMode: 'discover-managed';
      readonly reuseExistingInventory: true;
    }
  | {
      readonly inventoryMode: 'discover';
      readonly reuseExistingInventory: true;
    } {
  return inventoryMode === 'cached-only'
    ? { inventoryMode: 'cached-only' }
    : { inventoryMode, reuseExistingInventory: true };
}

function publicationUnavailable(input: {
  readonly isDisposed: () => boolean;
  readonly isSuperseded: () => boolean;
}): 'disposed' | 'superseded' | undefined {
  if (input.isDisposed()) return 'disposed';
  if (input.isSuperseded()) return 'superseded';
  return undefined;
}

const DEFAULT_MCP_DISCOVERY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000, 300_000] as const;

export interface PluginMcpDiscoverySchedulerOptions {
  readonly delaysMs?: readonly number[];
  readonly drainTimeoutMs?: number;
  readonly prepare: (snapshot: PluginSnapshot) => Promise<PendingPluginPublication>;
  readonly isCurrent: (expectedRevision: string, scopeKey: string) => boolean;
  readonly queue: (publication: PendingPluginPublication) => void;
}

interface PluginMcpDiscoveryTask {
  operation?: Promise<void>;
}

/** Owns bounded retry and lifecycle cleanup for non-blocking MCP inventory discovery. */
export class PluginMcpDiscoveryScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tasks = new Set<PluginMcpDiscoveryTask>();
  private capabilityKey = '';
  private failureCount = 0;
  private activeTask: PluginMcpDiscoveryTask | undefined;
  private queued:
    | {
        readonly snapshot: PluginSnapshot;
        readonly expectedRevision: string;
        readonly scopeKey: string;
      }
    | undefined;
  private disposed = false;

  constructor(private readonly options: PluginMcpDiscoverySchedulerOptions) {}

  published(
    discovery: PluginMcpDiscoveryPublication,
    publishedSnapshot: PluginSnapshot,
    scopeKey: string,
  ): void {
    if (discovery.next === 'complete') {
      this.succeeded(discovery.snapshot);
      return;
    }
    this.schedule(discovery.snapshot, publishedSnapshot.revision, scopeKey, discovery.next);
  }

  scopeChanged(): void {
    this.cancelDelay();
    this.queued = undefined;
    this.capabilityKey = '';
    this.failureCount = 0;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelDelay();
    this.queued = undefined;
    await waitForBounded(
      Promise.allSettled(
        [...this.tasks].flatMap((task) => (task.operation ? [task.operation] : [])),
      ),
      this.options.drainTimeoutMs ?? 5_000,
    );
  }

  private schedule(
    snapshot: PluginSnapshot,
    expectedRevision: string,
    scopeKey: string,
    mode: 'immediate' | 'retry',
  ): void {
    if (this.disposed || !this.options.isCurrent(expectedRevision, scopeKey)) return;
    const key = mcpDiscoveryKey(snapshot);
    if (mode === 'immediate' || key !== this.capabilityKey) {
      this.cancelDelay();
      this.capabilityKey = key;
      this.failureCount = 0;
    }
    if (mode === 'immediate') {
      this.start(snapshot, expectedRevision, scopeKey);
      return;
    }
    if (this.timer) return;
    const delays = this.delays();
    const delayMs = delays[Math.min(this.failureCount, delays.length - 1)] ?? 300_000;
    this.failureCount += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start(snapshot, expectedRevision, scopeKey);
    }, delayMs);
    this.timer.unref?.();
  }

  private start(snapshot: PluginSnapshot, expectedRevision: string, scopeKey: string): void {
    if (this.disposed || !this.options.isCurrent(expectedRevision, scopeKey)) return;
    if (this.activeTask) {
      this.queued = { snapshot, expectedRevision, scopeKey };
      return;
    }
    const task: PluginMcpDiscoveryTask = {};
    this.activeTask = task;
    this.tasks.add(task);
    task.operation = this.removeWhenSettled(
      this.discover(snapshot, expectedRevision, scopeKey),
      task,
    );
  }

  private async removeWhenSettled(
    operation: Promise<void>,
    task: PluginMcpDiscoveryTask,
  ): Promise<void> {
    try {
      await operation;
    } catch {
      // Discovery is fail-open; retry scheduling owns expected failures.
    } finally {
      this.tasks.delete(task);
      if (this.activeTask === task) this.activeTask = undefined;
      this.startQueued();
    }
  }

  private startQueued(): void {
    if (this.disposed || this.activeTask || !this.queued) return;
    const queued = this.queued;
    this.queued = undefined;
    this.start(queued.snapshot, queued.expectedRevision, queued.scopeKey);
  }

  private async discover(
    snapshot: PluginSnapshot,
    expectedRevision: string,
    scopeKey: string,
  ): Promise<void> {
    let publication: PendingPluginPublication;
    try {
      publication = await this.options.prepare(snapshot);
    } catch {
      this.schedule(snapshot, expectedRevision, scopeKey, 'retry');
      return;
    }
    if (this.disposed || !this.options.isCurrent(expectedRevision, scopeKey)) {
      await ignoreFailure(publication.cancel?.());
      return;
    }
    this.options.queue(publication);
  }

  private succeeded(snapshot: PluginSnapshot): void {
    if (mcpDiscoveryKey(snapshot) !== this.capabilityKey) return;
    this.cancelDelay();
    this.failureCount = 0;
  }

  private cancelDelay(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private delays(): readonly number[] {
    return this.options.delaysMs?.length ? this.options.delaysMs : DEFAULT_MCP_DISCOVERY_DELAYS_MS;
  }
}

function mcpDiscoveryPublication(
  snapshot: PluginSnapshot,
  inventoryMode: PluginMcpInventoryMode,
  failedServerCount: number,
  diagnostics: readonly { readonly code: string }[],
): PluginMcpDiscoveryPublication | undefined {
  if (inventoryMode === 'cached-only') {
    return failedServerCount > 0 ? { snapshot, next: 'immediate' } : undefined;
  }
  if (inventoryMode === 'discover-managed' && failedServerCount > 0) {
    return {
      snapshot,
      next: diagnostics.some((diagnostic) => diagnostic.code === 'MCP_SERVER_WARMING')
        ? 'immediate'
        : 'retry',
    };
  }
  return { snapshot, next: failedServerCount > 0 ? 'retry' : 'complete' };
}

function mcpDiscoveryKey(snapshot: PluginSnapshot): string {
  return JSON.stringify(snapshot.mcpServers);
}

async function waitForBounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function cancelPreparedCandidate(
  runtime: PluginMcpRuntimePort | undefined,
  options: PluginPublicationOptions,
  participant?: PreparedMiniAppPluginPublication,
): Promise<void> {
  await runAllFinallyIgnoringFailure([
    () => runtime?.close(),
    () => participant?.rollback(),
    () => options.cancel?.(),
  ]);
}

export function officialPublicationOptions(
  prepared: PreparedOfficialPluginReconciliation | undefined,
  completion: Deferred<void>,
  scopeChangedError: () => Error,
): PluginPublicationOptions {
  if (!prepared) return { completion };
  return {
    completion,
    commit: async () => {
      if (!prepared.commit()) throw scopeChangedError();
    },
    rollback: async () => {
      prepared.rollback();
      await prepared.abort();
    },
    finalize: async () => prepared.finalize(),
    cancel: async () => prepared.abort(),
  };
}

export function isPublicationSuperseded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'PUBLICATION_SUPERSEDED'
  );
}

export function sameLocalPluginProjection(left: PluginSnapshot, right: PluginSnapshot): boolean {
  if (left.localPlugins.length !== right.localPlugins.length) return false;
  return left.localPlugins.every((plugin, index) => {
    const other = right.localPlugins[index];
    return (
      other !== undefined &&
      plugin.rootPath === other.rootPath &&
      plugin.contentDigest === other.contentDigest &&
      plugin.enabled === other.enabled
    );
  });
}

async function ignoreFailure(promise: Promise<unknown> | undefined): Promise<void> {
  try {
    await promise;
  } catch {
    // Cancellation and shutdown continue after best-effort resource cleanup.
  }
}

async function runAllFinallyIgnoringFailure(
  operations: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  for (const operation of operations) await ignoreFailure(operation());
}
