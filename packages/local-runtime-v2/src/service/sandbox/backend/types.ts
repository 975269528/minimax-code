import type {
  SandboxFilesystemPolicy,
  SandboxLocalAccess,
  SandboxNetworkPolicy,
} from '@mavis/config';

export type SandboxPolicyPathRoot =
  | 'workspace'
  | 'git-dir'
  | 'common-dir'
  | 'session-temp'
  /**
   * Platform recoverable-delete destination (macOS `~/.Trash`, XDG
   * `$XDG_DATA_HOME/Trash`). Write-only: it is deliberately NEVER part of
   * `unlinkAllowOnly`, so `delete_guard` keeps constraining WHICH files may be
   * removed while still letting the execution layer move them out of the way.
   */
  | 'trash'
  | 'host-root';

/** Product-level policy IR. Backends translate this into their native runtime config. */
export interface SandboxEffectivePolicy {
  readonly enabled: boolean;
  readonly filesystem: {
    readonly mode: SandboxFilesystemPolicy['mode'];
    readonly allowWrite: readonly SandboxPolicyPathRoot[];
    readonly unlinkAllowOnly: readonly SandboxPolicyPathRoot[];
    readonly denyRead: readonly string[];
    readonly denyWrite: readonly string[];
  };
  readonly network: {
    readonly mode: SandboxNetworkPolicy['mode'];
    /**
     * Whether the sandbox actively enforces any network restriction. The
     * desktop product ships with unrestricted network: the compiler always
     * emits `false`, and backends translate that into disabling their whole
     * network subsystem (proxy, seatbelt network rules, env injection).
     */
    readonly enforce: boolean;
    readonly allowedDomains: readonly [];
    readonly deniedDomains: readonly string[];
    readonly strictAllowlist: true;
    readonly allowAll: boolean;
  };
  readonly localAccess: SandboxLocalAccess;
}

interface SandboxInvocationFilesystemPolicy {
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly unlinkAllowOnly: readonly string[];
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
}

export type SandboxBackendCapabilities = {
  /** Whether the backend supports per-call filesystem overrides. */
  perCallFilesystem: boolean;
  /** Whether rename/unlink sources can be independently restricted. */
  operationScopedDelete: 'source-unlink' | 'unsupported';
  /** Whether network policy can be swapped without restarting the proxy. */
  liveNetworkRuleSwap: boolean;
  filesystemModes: ReadonlyArray<SandboxFilesystemPolicy['mode']>;
  networkModes: ReadonlyArray<SandboxNetworkPolicy['mode']>;
  localAccessLevels: ReadonlyArray<SandboxLocalAccess>;
  credentialFileMask: 'mask' | 'deny-only' | 'unsupported';
  /**
   * `per-invocation` cleanup affects only the completed invocation.
   * `process-wide` cleanup must wait until every invocation releases the backend handle.
   */
  cleanupGranularity: 'per-invocation' | 'process-wide';
};

export type SandboxBackendId = 'srt-macos';
export type SandboxBackendIdForTest = SandboxBackendId | 'fake';

export type SandboxBackendDescriptorForTest = {
  readonly id: SandboxBackendIdForTest;
  readonly platform: NodeJS.Platform;
  readonly priority: number;
  create(): SandboxPlatformBackend;
};

export interface SandboxBackendViolation {
  readonly category: string;
  readonly commandId?: string;
  readonly operation?: string;
  readonly resource?: string;
  readonly timestampMs: number;
}

export interface SandboxBackendHooks {
  reportViolation(violation: SandboxBackendViolation): void;
}

export interface PreparedNetworkPolicy {
  readonly backendId: SandboxBackendIdForTest;
  readonly opaque: unknown;
}

export interface SandboxInvocationHandle {
  readonly backendId: SandboxBackendIdForTest;
  readonly invocationId: string;
  readonly opaque?: unknown;
}

export interface SandboxWrapInput {
  readonly command: string;
  readonly cwd: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly sandboxTempDir: string;
  readonly abortSignal?: AbortSignal;
  readonly commandId: string;
  readonly commandText: string;
  readonly gitSafeDirectories: readonly string[];
  readonly filesystem: SandboxInvocationFilesystemPolicy;
}

export interface SandboxWrapResult {
  readonly observation?: Readonly<Record<string, unknown>>;
  readonly command: string;
  readonly env: NodeJS.ProcessEnv;
  readonly handle: SandboxInvocationHandle;
}

export interface SandboxPlatformBackend {
  readonly id: SandboxBackendIdForTest;
  readonly capabilities: SandboxBackendCapabilities;
  describeVersions(): { backendVersion: string; upstreamVersion?: string };
  /** Compile the backend runtime config and run its schema without publishing it. */
  validatePolicy(policy: SandboxEffectivePolicy): void | Promise<void>;
  initialize(policy: SandboxEffectivePolicy, hooks: SandboxBackendHooks): Promise<void>;
  /** Synchronous, no-fail module-global config publication after disk commit. */
  updateConfig(policy: SandboxEffectivePolicy): void;
  prepareNetworkPolicy(policy: SandboxEffectivePolicy['network']): Promise<PreparedNetworkPolicy>;
  publishNetworkPolicy(policy: PreparedNetworkPolicy): void;
  wrap(input: SandboxWrapInput): Promise<SandboxWrapResult>;
  /** This method must affect only the referenced invocation. */
  onInvocationEnd(handle: SandboxInvocationHandle): Promise<void>;
  /** Process-wide cleanup runs only after all backend handle references reach zero. */
  onProcessCleanup(): Promise<void>;
  reset(): Promise<void>;
}
