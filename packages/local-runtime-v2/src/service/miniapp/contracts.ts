export type MiniAppHostConnectorPolicy =
  | { readonly kind: 'deny-all' }
  | { readonly kind: 'allowlist'; readonly providers: readonly string[] };

interface MiniAppCandidateBase {
  readonly pluginId: string;
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly clientDigest: string;
  readonly surfacePath: string;
}

export interface ProcessMiniAppCandidate extends MiniAppCandidateBase {
  readonly lifecycle: 'on-demand';
  readonly nodeDigest: string;
  readonly nodeEntry: string;
  readonly mcpEndpoints: readonly {
    readonly id: string;
    readonly path: string;
  }[];
  readonly hostConnectorPolicy: MiniAppHostConnectorPolicy;
}

/** Process-only package contract consumed by the PluginSystem composition layer. */
export type MiniAppCandidate = ProcessMiniAppCandidate;

export interface MiniAppRuntimeExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly shutdownRequested: boolean;
}

export interface MiniAppHostConnectorQuiesceAttempt {
  readonly result: Promise<'drained' | 'busy'>;
  /** Re-opens admission after a non-destructive pre-PONR failure. */
  resume(): boolean;
  /** Irreversibly retires the drained Connector binding before root shutdown. */
  commit(): Promise<void>;
}

export interface MiniAppHostConnectorSession {
  startHandshake(): void;
  activate(): void;
  beginQuiesce(input: {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
  }): MiniAppHostConnectorQuiesceAttempt;
  retire(): Promise<void>;
  close(): Promise<void>;
}

export interface MiniAppHostConnectorReadable {
  on(event: 'data' | 'end' | 'error', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MiniAppHostConnectorWritable {
  readonly destroyed?: boolean;
  write(chunk: Buffer): boolean;
  once(event: 'drain' | 'error' | 'close', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface MiniAppHostConnectorSessionFactory {
  create(input: {
    readonly pluginId: string;
    readonly processGeneration: string;
    readonly providers: readonly string[];
    readonly request: MiniAppHostConnectorReadable;
    readonly response: MiniAppHostConnectorWritable;
    readonly onFatal: (error: Error) => void;
  }): MiniAppHostConnectorSession;
}

export interface MiniAppRuntimeLogEvent {
  readonly processGeneration: string;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly byteLength: number;
  readonly fieldKeys: readonly string[];
}

export interface MiniAppRuntimeLogEntry extends MiniAppRuntimeLogEvent {
  readonly sequence: number;
  readonly atMs: number;
  readonly miniAppGeneration: string;
}

export interface MiniAppNodeRuntime {
  readonly processGeneration: string;
  readonly nodeDigest: string;
  readonly port: number;
  readonly origin: string;
  readonly hostConnectorSession?: MiniAppHostConnectorSession;
  readonly closed: Promise<MiniAppRuntimeExit>;
  stop(): Promise<{ readonly proven: boolean }>;
}

export interface MiniAppNodeRuntimeFactory {
  prepare(input: {
    readonly candidate: ProcessMiniAppCandidate;
    readonly processGeneration: string;
    readonly preferredPort?: number;
    readonly signal: AbortSignal;
    readonly onLog: (event: MiniAppRuntimeLogEvent) => void;
  }): Promise<MiniAppNodeRuntime>;
}

export interface MiniAppPersistedState {
  readonly pluginId: string;
  readonly acceptedSourceDigest: string;
  readonly clientDigest: string;
  readonly nodeDigest: string;
  readonly preferredPort?: number;
  readonly lastErrorJson?: string;
  readonly updatedAtMs: number;
}

export interface MiniAppStateStore {
  read(pluginId: string): MiniAppPersistedState | undefined;
  list(): readonly MiniAppPersistedState[];
  write(state: MiniAppPersistedState): void;
  remove(pluginId: string): void;
}

export interface MiniAppPublishedView {
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

export interface MiniAppGenerationLease {
  release(): Promise<boolean>;
}

export interface PreparedMiniAppTransition {
  readonly candidate: MiniAppCandidate;
  readonly target: MiniAppPublishedView;
  readonly willPublishCold: boolean;
  commit(): Promise<MiniAppPublishedView>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface PreparedMiniAppDisableTransition {
  readonly pluginId: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface PreparedMiniAppStopTransition {
  readonly pluginId: string;
  readonly target: MiniAppPublishedView;
  commit(): Promise<MiniAppPublishedView>;
  rollback(): Promise<void>;
  finalize(): Promise<void>;
}

export interface MiniAppPreparationOptions {
  /** Starts the direct Node root for an explicit open/publish/restart operation. */
  readonly forceStart?: boolean;
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline for pre-PONR managed and Connector drain. */
  readonly deadlineMs?: number;
}

export interface MiniAppStopOptions {
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline for pre-PONR managed and Connector drain. */
  readonly deadlineMs?: number;
}

export interface MiniAppStatus {
  readonly pluginId: string;
  readonly phase:
    | 'inactive'
    | 'cold'
    | 'starting'
    | 'active'
    | 'preparing'
    | 'disabled'
    | 'failed'
    | 'quarantined';
  readonly active?: MiniAppPublishedView;
  readonly retiringGenerationIds: readonly string[];
  readonly leaseCount: number;
  readonly failureCode?: string;
  readonly logs: readonly MiniAppRuntimeLogEntry[];
}

interface MiniAppPublicationCoordinator {
  prepare(
    candidate: MiniAppCandidate,
    options?: MiniAppPreparationOptions,
  ): Promise<PreparedMiniAppTransition>;
  prepareDisable(pluginId: string): Promise<PreparedMiniAppDisableTransition>;
  prepareStop(
    pluginId: string,
    options?: MiniAppStopOptions,
  ): Promise<PreparedMiniAppStopTransition>;
  canReusePreparedPackage(input: {
    readonly pluginId: string;
    readonly packageDigest: string;
    readonly clientDigest: string;
    readonly nodeDigest: string;
  }): boolean;
  disable(pluginId: string): Promise<void>;
  stop(pluginId: string, options?: MiniAppStopOptions): Promise<void>;
}

export interface MiniAppSupervisor extends MiniAppPublicationCoordinator {
  ready(): Promise<void>;
  /** Synchronous, side-effect-free fence for an operation on a managed runtime endpoint. */
  assertCurrentRun(input: { readonly pluginId: string; readonly runId: string }): undefined;
  acquire(input: {
    readonly pluginId: string;
    readonly expectedMiniAppGeneration?: string;
    readonly expectedProcessGeneration?: string;
  }): Promise<MiniAppGenerationLease>;
  inspect(pluginId?: string): readonly MiniAppStatus[];
  close(): Promise<void>;
}

export interface MiniAppSupervisorOptions {
  readonly stateStore: MiniAppStateStore;
  readonly nodeRuntime: MiniAppNodeRuntimeFactory;
  readonly verifyCandidate: (candidate: MiniAppCandidate) => Promise<boolean>;
  readonly nowMs?: () => number;
  readonly makeMiniAppGeneration?: () => string;
  readonly makeProcessGeneration?: () => string;
  readonly makeLeaseId?: () => string;
  readonly closeTimeoutMs?: number;
  readonly logCapacity?: number;
  readonly idleTimeoutMs?: number;
  readonly scheduleIdle?: (delayMs: number, callback: () => void) => { cancel(): void };
}
