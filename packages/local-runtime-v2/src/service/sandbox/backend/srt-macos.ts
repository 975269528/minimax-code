import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  NetworkConfigSchema,
  SandboxRuntimeConfigSchema,
  type NetworkConfig,
  type SandboxRuntimeConfig,
  type SandboxViolationEvent,
} from '@minimax/mcode-sandbox-runtime';
import {
  __getCommandTextMapSize,
  SandboxManager,
} from '@minimax/mcode-sandbox-runtime/dist/sandbox/sandbox-manager.js';

import { SandboxError } from '../sandbox-errors.js';
import type {
  SandboxBackendCapabilities,
  SandboxBackendHooks,
  SandboxEffectivePolicy,
  SandboxInvocationHandle,
  SandboxPlatformBackend,
  SandboxWrapInput,
  SandboxWrapResult,
} from './types.js';

interface SrtViolationStorePort {
  getTotalCount(): number;
  subscribe(listener: (violations: SandboxViolationEvent[]) => void): () => void;
}

interface SrtMacosManagerPort {
  initialize(
    config: SandboxRuntimeConfig,
    askCallback: undefined,
    enableLogMonitor: boolean,
  ): Promise<void>;
  getConfig(): SandboxRuntimeConfig | undefined;
  updateConfig(config: SandboxRuntimeConfig): void;
  wrapWithSandbox: typeof SandboxManager.wrapWithSandbox;
  getSandboxViolationStore(): SrtViolationStorePort;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

const SRT_MACOS_CAPABILITIES: SandboxBackendCapabilities = Object.freeze({
  perCallFilesystem: true,
  operationScopedDelete: 'source-unlink',
  liveNetworkRuleSwap: true,
  filesystemModes: ['read_only', 'workspace_write', 'delete_guard', 'full_access'] as const,
  networkModes: ['deny', 'allow_all'] as const,
  localAccessLevels: ['open', 'restricted'] as const,
  credentialFileMask: 'deny-only',
  cleanupGranularity: 'process-wide',
});

/**
 * Build-time constant for the bundled SRT runtime version. It must match the exact
 * `@minimax/mcode-sandbox-runtime` pin in `packages/local-runtime-v2/package.json`;
 * the srt-macos unit tests fail on drift. Reading the dependency's `package.json`
 * via `createRequire` at runtime is forbidden here: the published TUI bundle does
 * not ship that file, and the unhandled `MODULE_NOT_FOUND` fired before
 * `manager.initialize()` and left the whole sandbox in `failed`.
 */
const SRT_RUNTIME_VERSION = '0.0.74-mcode.2';

export function createSrtMacosBackend(
  manager: SrtMacosManagerPort = SandboxManager,
  runtimeVersion = SRT_RUNTIME_VERSION,
): SandboxPlatformBackend {
  const validatedPolicies = new WeakMap<SandboxEffectivePolicy, SandboxRuntimeConfig>();
  let publishedConfig = restrictiveRuntimeConfig();
  let configRevision = 0;
  let preparedNetworkBase = publishedConfig.network;
  let unsubscribeViolations: (() => void) | undefined;

  return {
    id: 'srt-macos',
    capabilities: SRT_MACOS_CAPABILITIES,
    describeVersions: () => ({ backendVersion: runtimeVersion, upstreamVersion: '0.0.74' }),
    validatePolicy(policy) {
      const config = SandboxRuntimeConfigSchema.parse(runtimeConfig(policy));
      validatedPolicies.set(policy, config);
      preparedNetworkBase = config.network;
    },
    async initialize(policy, hooks) {
      const config =
        validatedPolicies.get(policy) ?? SandboxRuntimeConfigSchema.parse(runtimeConfig(policy));
      unsubscribeViolations?.();
      unsubscribeViolations = subscribeToViolations(manager.getSandboxViolationStore(), hooks);
      try {
        // macOS log stream scans system logs even while the runtime is idle.
        // Disable that diagnostic collector; sandbox enforcement is configured separately.
        await manager.initialize(config, undefined, false);
        publishedConfig = config;
        configRevision += 1;
        preparedNetworkBase = config.network;
      } catch (error) {
        unsubscribeViolations();
        unsubscribeViolations = undefined;
        throw error;
      }
    },
    updateConfig(policy) {
      publishedConfig = validatedPolicies.get(policy) ?? runtimeConfig(policy);
      preparedNetworkBase = publishedConfig.network;
      manager.updateConfig(publishedConfig);
      configRevision += 1;
    },
    async prepareNetworkPolicy(policy) {
      const network = NetworkConfigSchema.parse(networkConfig(policy, preparedNetworkBase));
      return { backendId: 'srt-macos', opaque: network };
    },
    publishNetworkPolicy(policy) {
      publishedConfig = { ...publishedConfig, network: policy.opaque as NetworkConfig };
      preparedNetworkBase = publishedConfig.network;
      manager.updateConfig(publishedConfig);
      configRevision += 1;
    },
    async wrap(input): Promise<SandboxWrapResult> {
      try {
        // `git init`/`git clone` copy hook templates into `.git/hooks`, which
        // SRT's mandatory cwd-anchored deny rejects in production (runtime cwd
        // an ancestor of the workspace), failing the whole init/clone. Pointing
        // GIT_TEMPLATE_DIR at a genuinely empty directory makes git skip
        // template copying entirely (an empty env value no longer does on
        // git >= 2.53). The directory lives inside sandboxTempDir so it is
        // always readable from within the sandbox; mkdir is idempotent.
        const gitTemplateDir = join(input.sandboxTempDir, 'git-templates-empty');
        await mkdir(gitTemplateDir, { recursive: true });
        const observation = {
          sampling: 'wrap_requested',
          backend_config_revision: configRevision,
          local_access: publishedConfig.allowAppleEvents === true ? 'open' : 'restricted',
          // Git config writes are always allowed; the toggle no longer exists.
          allow_git_config: true,
          network_decision_generation: null,
        };
        const command = await manager.wrapWithSandbox(
          input.command,
          undefined,
          perInvocationConfig(input),
          input.abortSignal,
          {
            commandId: input.commandId,
            commandText: input.commandText,
            baseEnv: input.baseEnv,
            sandboxTempDir: input.sandboxTempDir,
          },
        );
        return {
          command,
          observation,
          // Recoverable deletion must stay INSIDE the cage. `mavis-trash`
          // otherwise prefers the desktop trash service (Finder via Apple
          // Events, `gio trash` on Linux), which performs the unlink in a
          // separate unsandboxed process — the kernel would never evaluate
          // `unlinkAllowOnly` and `delete_guard` would silently not hold.
          // Outside the sandbox this variable is absent, so the desktop path
          // (and its "Put Back" metadata) is preserved.
          //
          // GIT_TEMPLATE_DIR (see above) suppresses hook-template copies. A
          // caller baseEnv value or an explicit `--template=<dir>` still wins.
          env: {
            GIT_TEMPLATE_DIR: gitTemplateDir,
            ...input.baseEnv,
            MAVIS_TRASH_FORCE_MV: '1',
          },
          handle: { backendId: 'srt-macos', invocationId: input.commandId },
        };
      } catch (error) {
        throw new SandboxError(
          'SANDBOX_WRAP_FAILED',
          'pre-spawn',
          error instanceof Error ? error.message : 'SRT failed to wrap command',
        );
      }
    },
    async onInvocationEnd(_handle: SandboxInvocationHandle): Promise<void> {
      // SRT cleanup is process-wide; the service calls it only after all leases retire.
    },
    async onProcessCleanup() {
      manager.cleanupAfterCommand();
    },
    async reset() {
      unsubscribeViolations?.();
      unsubscribeViolations = undefined;
      await manager.reset();
      publishedConfig = restrictiveRuntimeConfig();
      preparedNetworkBase = publishedConfig.network;
    },
  };
}

function runtimeConfig(policy: SandboxEffectivePolicy): SandboxRuntimeConfig {
  const localOpen = policy.localAccess === 'open';
  return {
    network: networkConfig(
      policy.network,
      {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowAll: false,
      },
      policy.localAccess,
    ),
    filesystem: {
      disabled: false,
      denyRead: [...policy.filesystem.denyRead],
      allowRead: [],
      allowWrite: [],
      unlinkAllowOnly: [],
      denyWrite: [...policy.filesystem.denyWrite],
      // Product policy: `.git/config` writes are always allowed. init/clone/
      // worktree require them, and in every mode that can write the workspace
      // the agent can already write arbitrary executables, so denying the
      // config file only breaks normal Git usage. Not configurable.
      allowGitConfig: true,
    },
    enableWeakerNetworkIsolation: localOpen,
    allowAppleEvents: localOpen,
    allowSecurityServer: localOpen,
    allowPty: localOpen,
  };
}

/**
 * SRT `network.disabled: true` turns the whole network subsystem off: no proxy
 * startup, unrestricted seatbelt network rules, zero proxy/cert env injection.
 * The exact-pinned `@minimax/mcode-sandbox-runtime` (>= 0.0.74-mcode.2, see
 * `SRT_RUNTIME_VERSION`) ships `disabled` in `NetworkConfigSchema`, so schema,
 * type and runtime consume the key from the same package. Older product
 * binaries bundle an older SRT and are unaffected by this code.
 */
function networkConfig(
  policy: SandboxEffectivePolicy['network'],
  previous: NetworkConfig,
  localAccess?: SandboxEffectivePolicy['localAccess'],
): NetworkConfig {
  return {
    ...previous,
    allowedDomains: [],
    deniedDomains: [...policy.deniedDomains],
    strictAllowlist: true,
    allowAll: policy.allowAll,
    ...localNetworkConfig(localAccess),
    ...(policy.enforce === false ? { disabled: true } : {}),
  };
}

function localNetworkConfig(
  localAccess: SandboxEffectivePolicy['localAccess'] | undefined,
): Partial<NetworkConfig> {
  if (localAccess === undefined) return {};
  if (localAccess === 'open') return { allowAllUnixSockets: true, allowLocalBinding: true };
  return {
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
  };
}

function perInvocationConfig(input: SandboxWrapInput): Partial<SandboxRuntimeConfig> {
  return {
    filesystem: {
      disabled: false,
      allowRead: [...input.filesystem.allowRead],
      allowWrite: [...input.filesystem.allowWrite],
      unlinkAllowOnly: [...input.filesystem.unlinkAllowOnly],
      denyRead: [...input.filesystem.denyRead],
      denyWrite: [...input.filesystem.denyWrite],
      // Always allowed; see runtimeConfig().
      allowGitConfig: true,
    },
    git: { safeDirectories: [...input.gitSafeDirectories] },
  };
}

function restrictiveRuntimeConfig(): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ['*'],
      strictAllowlist: true,
      allowAll: false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      disabled: false,
      allowRead: [],
      allowWrite: [],
      unlinkAllowOnly: [],
      denyRead: [],
      denyWrite: [],
      allowGitConfig: false,
    },
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    allowSecurityServer: false,
    allowPty: false,
  };
}

function subscribeToViolations(
  store: SrtViolationStorePort,
  hooks: SandboxBackendHooks,
): () => void {
  let seen = store.getTotalCount();
  return store.subscribe((violations) => {
    const total = store.getTotalCount();
    const added = Math.max(0, total - seen);
    if (added === 0) {
      seen = total;
      return;
    }
    for (const violation of violations.slice(-Math.min(added, violations.length))) {
      hooks.reportViolation({
        ...classifyViolationLine(violation.line),
        ...(violation.command ? { commandId: violation.command } : {}),
        timestampMs: violation.timestamp.getTime(),
      });
    }
    seen = total;
  });
}

/** Proxy-produced heads, emitted by SRT as `deny <head> <target> (<reason>)`. */
const PROXY_OPERATIONS = ['http-request', 'network-outbound'] as const;
const SEATBELT_HEAD = /^[^\s()]+\(\d+\) deny\(\d+\) ([a-z][a-z0-9-]*)/;
const SEATBELT_LOCAL_PREFIX = /^(?:mach|ipc|authorization|appleevent)-/;
const SEATBELT_LOCAL_OPERATIONS = new Set(['system-socket', 'pseudo-tty']);

/**
 * Seatbelt monitor and network-proxy denials land in one untagged SRT store, so
 * the producer can only be recovered from the line itself. Classification is
 * therefore anchored on the two stable heads SRT emits and never reads the path
 * or URL tail: that tail is command-controlled, and scanning it would let a file
 * name decide the reported source, operation and target. The returned category
 * and operation tokens are the closed vocabulary `SandboxObservability` maps
 * onto its coarse enums.
 *
 * Limits, deliberately accepted here rather than abstracted away: this couples
 * the adapter to SRT's line prefixes (a producer tag on the event would replace
 * it), a seatbelt operation outside the three known families falls back to the
 * stable unknown/backend bucket instead of claiming one, and seatbelt file
 * targets stay coarse because the concrete path is never inspected.
 */
function classifyViolationLine(line: string): { category: string; operation?: string } {
  const proxyOperation = PROXY_OPERATIONS.find((operation) =>
    line.startsWith(`deny ${operation} `),
  );
  if (proxyOperation) return { category: 'proxy-network', operation: proxyOperation };
  const seatbeltOperation = SEATBELT_HEAD.exec(line)?.[1];
  const category = seatbeltOperation ? seatbeltCategory(seatbeltOperation) : undefined;
  if (!seatbeltOperation || !category) return { category: 'unknown' };
  return { category, operation: seatbeltOperation };
}

function seatbeltCategory(operation: string): string | undefined {
  if (operation.startsWith('file-')) return 'seatbelt-file';
  if (operation.startsWith('network-')) return 'seatbelt-network';
  if (SEATBELT_LOCAL_PREFIX.test(operation) || SEATBELT_LOCAL_OPERATIONS.has(operation)) {
    return 'seatbelt-local';
  }
  return undefined;
}

/** @internal Test-only probe for the fork's command-text retention invariant. */
export function __getSrtCommandTextMapSizeForTest(): number {
  return __getCommandTextMapSize();
}

/** @internal Intentionally permits omitting commandText for the reverse regression case. */
export async function __probeSrtCommandTextRegistrationForTest(input: {
  readonly commandId: string;
  readonly commandText?: string;
}): Promise<void> {
  try {
    await SandboxManager.wrapWithSandbox(
      'printf mcode-sandbox-command-text-probe',
      undefined,
      {
        filesystem: {
          disabled: true,
          denyRead: [],
          allowRead: [],
          allowWrite: [],
          unlinkAllowOnly: [],
          denyWrite: [],
          allowGitConfig: false,
        },
      },
      undefined,
      {
        commandId: input.commandId,
        ...(input.commandText ? { commandText: input.commandText } : {}),
        baseEnv: {},
        sandboxTempDir: '/tmp',
      },
    );
  } catch {
    // Registration happens before platform wrapping; unsupported CI hosts may reject later.
  }
}
