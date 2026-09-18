import { type SkillSourceKind, type SkillSourceRoot } from '@mavis/skills';
import type { SkillFileInfo, SkillInfo } from '@mavis/protocol/local';

import { matchesAgentResourceInstance } from '../agent/resource-instance.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { SubagentTelemetryHost } from '../agent/subagent-telemetry.js';
import type { LocalSkillsCatalogEntry, LocalSkillsCatalogRenderResult } from './catalog.js';
import {
  createRegistryHandle,
  inheritedRuntimeReadBetaFlags,
  normalizeAgentName,
  type RegistryHandle,
} from './registry-handle.js';
import { readConfiguredSkillRoots } from './roots.js';
import {
  deleteRegistrySkill,
  getRegistrySkillDetail,
  hasRegistryLocationUri,
  inferAgentNameFromConfiguredLocationUri,
  listRegistryRuntimeSkills,
  listRegistrySkillFiles,
  listRegistrySkillSummaries,
  readRegistrySkillByName,
  readRegistrySkillFile,
  resolveRegistrySkillIdentity,
  renderLocalRegistrySkillsCatalog,
  type InstalledSkillHubMetadata,
} from './registry-operations.js';

export { readConfiguredSkillRoots } from './roots.js';

// The provider is process-scoped while workspace roots are session-scoped.
// Keep recent registries warm without retaining every historical session.
const MAX_CACHED_REGISTRY_HANDLES = 16;

export interface LocalSkillListInput {
  limit?: number;
  cursor?: string;
  scope?: number | string;
  sourceType?: number | string;
  keyword?: string;
  excludeBuiltin?: boolean;
  agentName?: string;
  /** Canonical-first family roots used for read-through compatibility. */
  compatibleAgentNames?: readonly string[];
  /** Exclude unavailable private roots; verified same-instance resources remain optional. */
  excludeAgentResources?: boolean;
  expectedAgentInstanceId?: string;
  workspaceDir?: string;
  /** Effective runtime feature flags used to hide unavailable gated skills. */
  betaFlags?: Readonly<Record<string, boolean | undefined>>;
}

export interface LocalSkillRuntimeListInput {
  agentName?: string;
  compatibleAgentNames?: readonly string[];
  /** Exclude unavailable private roots; verified same-instance resources remain optional. */
  excludeAgentResources?: boolean;
  expectedAgentInstanceId?: string;
  workspaceDir?: string;
  betaFlags?: Readonly<Record<string, boolean | undefined>>;
  injectableBuiltinSkillNames?: ReadonlySet<string>;
  /** Canonical standalone selector, already normalized by the service boundary. */
  allowedSkillNames?: ReadonlySet<string>;
  /** Split-bucket selector for Agent/global/workspace extension Skills. */
  allowedExtensionSkillNames?: ReadonlySet<string>;
}

export interface LocalSkillCatalogInput extends LocalSkillRuntimeListInput {
  injectableBuiltinSkillNames?: ReadonlySet<string>;
  contextWindowTokens?: number;
  additionalSkills?: readonly LocalSkillsCatalogEntry[];
}

export interface LocalSkillRequestInput {
  skillName: string;
  locationUri?: string;
  agentName?: string;
  compatibleAgentNames?: readonly string[];
  /** Exclude unavailable private roots; verified same-instance resources remain optional. */
  excludeAgentResources?: boolean;
  expectedAgentInstanceId?: string;
  workspaceDir?: string;
  resourceAmbiguityTelemetry?: SubagentTelemetryHost;
}

export interface LocalSkillFileRequestInput extends LocalSkillRequestInput {
  path: string;
}

export interface LocalRegistrySkillReadResult {
  content: string;
  locationUri: string;
  sourceKind: SkillSourceKind;
}

export interface LocalSkillRegistryProvider {
  listSkills(
    input: LocalSkillListInput,
    installedHubMetadataByLocationUri?: ReadonlyMap<string, InstalledSkillHubMetadata>,
  ): Promise<{
    skills: SkillInfo[];
    hasMore: boolean;
    nextCursor?: string;
  }>;
  listRuntimeSkills(input?: LocalSkillRuntimeListInput): Promise<{
    skills: SkillInfo[];
    refreshedAt: number;
  }>;
  renderCatalog(input?: LocalSkillCatalogInput): Promise<LocalSkillsCatalogRenderResult>;
  readSkillByName(
    name: string,
    options?: {
      agentName?: string;
      compatibleAgentNames?: readonly string[];
      /** Exclude unavailable private roots; verified same-instance resources remain optional. */
      excludeAgentResources?: boolean;
      expectedAgentInstanceId?: string;
      workspaceDir?: string;
      betaFlags?: Readonly<Record<string, boolean | undefined>>;
      injectableBuiltinSkillNames?: ReadonlySet<string>;
      allowedSkillNames?: ReadonlySet<string>;
      allowedExtensionSkillNames?: ReadonlySet<string>;
      resourceAmbiguityTelemetry?: SubagentTelemetryHost;
    },
  ): Promise<LocalRegistrySkillReadResult | undefined>;
  getSkillDetail(
    input: LocalSkillRequestInput,
    options?: { includeBody?: boolean },
  ): Promise<{ skill: SkillInfo; content?: string } | undefined>;
  listSkillFiles(input: LocalSkillRequestInput): Promise<SkillFileInfo[] | undefined>;
  readSkillFile(input: LocalSkillFileRequestInput): Promise<string | undefined>;
  deleteSkill(
    input: LocalSkillRequestInput,
  ): Promise<{ ok: true; name: string } | 'protected' | undefined>;
  setSkillEnabled(
    input: LocalSkillRequestInput,
    enabled: boolean,
  ): Promise<{ ok: true; name: string; enabled: boolean } | undefined>;
  refresh(input?: { agentName?: string; workspaceDir?: string }): Promise<void>;
}

export type LocalSkillRegistryDiagnosticEvent =
  | {
      type: 'skill_registry_lru_close_begin';
      registryCacheCount: number;
    }
  | {
      type: 'skill_registry_lru_close_end';
      registryCacheCount: number;
      durationMs: number;
    };

export type LocalSkillRegistryDiagnosticSink = (event: LocalSkillRegistryDiagnosticEvent) => void;

export interface LocalSkillEnabledStatePort {
  getDisabledLocationUris(): Promise<ReadonlySet<string>>;
  setEnabled(locationUri: string, enabled: boolean): Promise<void>;
  forget(locationUri: string): Promise<void>;
}

export function createLocalSkillRegistryProvider(
  configGetter: () => LocalRuntimeConfig,
  rootsGetter?: (
    agentName?: string,
    workspaceDir?: string,
    compatibleAgentNames?: readonly string[],
  ) => SkillSourceRoot[],
  diagnosticSink?: LocalSkillRegistryDiagnosticSink,
  enabledState: LocalSkillEnabledStatePort = createProcessLocalSkillEnabledState(),
  readMcpServerNames: () => Promise<Set<string>> = async () => new Set(),
): LocalSkillRegistryProvider {
  const handles = new Map<string, RegistryHandle>();

  const emitDiagnostic = (event: LocalSkillRegistryDiagnosticEvent): void => {
    try {
      diagnosticSink?.(event);
    } catch {
      // Diagnostics are explicitly fail-open and never alter Skill behavior.
    }
  };

  function cacheHandle(rootsKey: string, handle: RegistryHandle): void {
    handles.delete(rootsKey);
    handles.set(rootsKey, handle);
    while (handles.size > MAX_CACHED_REGISTRY_HANDLES) {
      const oldest = handles.entries().next().value as [string, RegistryHandle] | undefined;
      if (!oldest) return;
      const [oldestKey, oldestHandle] = oldest;
      handles.delete(oldestKey);
      const startedAtMs = Date.now();
      emitDiagnostic({
        type: 'skill_registry_lru_close_begin',
        registryCacheCount: handles.size,
      });
      oldestHandle.close();
      emitDiagnostic({
        type: 'skill_registry_lru_close_end',
        registryCacheCount: handles.size,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
    }
  }

  async function getHandleForAgent(
    agentName: string | undefined,
    workspaceDir?: string,
    compatibleAgentNames?: readonly string[],
    excludeAgentResources = false,
    expectedAgentInstanceId?: string,
  ): Promise<RegistryHandle> {
    const resolvedAgentName = normalizeAgentName(agentName);
    const configuredRoots =
      rootsGetter?.(resolvedAgentName, workspaceDir, compatibleAgentNames) ??
      readConfiguredSkillRoots(
        configGetter(),
        resolvedAgentName,
        workspaceDir,
        compatibleAgentNames,
        excludeAgentResources,
      );
    const roots = excludeAgentResources
      ? configuredRoots.filter(
          (root) => root.kind !== 'agent' && !(root.kind === 'builtin' && root.scope),
        )
      : configuredRoots;
    const rootsKey = JSON.stringify([expectedAgentInstanceId, roots]);
    let handle = handles.get(rootsKey);
    if (!handle) {
      handle = createRegistryHandle(roots);
    }
    cacheHandle(rootsKey, handle);
    return handle;
  }

  async function getHandleForLocationUri(locationUri: string): Promise<RegistryHandle | undefined> {
    for (const [rootsKey, handle] of [...handles.entries()]) {
      const registry = await handle.registryPromise;
      if (hasRegistryLocationUri(registry, locationUri)) {
        if (handles.get(rootsKey) === handle) cacheHandle(rootsKey, handle);
        return handle;
      }
    }

    const defaultHandle = await getHandleForAgent(undefined);
    const defaultRegistry = await defaultHandle.registryPromise;
    if (hasRegistryLocationUri(defaultRegistry, locationUri)) return defaultHandle;

    const agentName = rootsGetter
      ? undefined
      : await inferAgentNameFromConfiguredLocationUri(configGetter(), locationUri);
    if (!agentName) return undefined;
    const agentHandle = await getHandleForAgent(agentName);
    const agentRegistry = await agentHandle.registryPromise;
    return hasRegistryLocationUri(agentRegistry, locationUri) ? agentHandle : undefined;
  }

  async function resolveSkillHandle(
    input: LocalSkillRequestInput,
  ): Promise<RegistryHandle | undefined> {
    if (input.locationUri && !input.excludeAgentResources && !input.expectedAgentInstanceId) {
      return getHandleForLocationUri(input.locationUri);
    }
    const handle = await getHandleForAgent(
      input.agentName,
      input.workspaceDir,
      input.compatibleAgentNames,
      input.excludeAgentResources,
      input.expectedAgentInstanceId,
    );
    if (
      input.locationUri &&
      !hasRegistryLocationUri(await handle.registryPromise, input.locationUri)
    ) {
      return undefined;
    }
    return handle;
  }

  async function withAgentResourceScope<
    TScope extends {
      agentName?: string;
      expectedAgentInstanceId?: string;
      excludeAgentResources?: boolean;
    },
    TResult,
  >(scope: TScope, read: (scope: TScope) => Promise<TResult>): Promise<TResult> {
    if (!scope.expectedAgentInstanceId || scope.excludeAgentResources) return read(scope);
    const matches = () =>
      matchesAgentResourceInstance(
        configGetter().dataDir,
        scope.agentName,
        scope.expectedAgentInstanceId!,
      );
    const unavailable = () => read({ ...scope, excludeAgentResources: true });
    if (!(await matches())) return unavailable();
    try {
      const result = await read(scope);
      // A cached URI or registry is not proof that the original Agent still owns the files.
      return (await matches()) ? result : unavailable();
    } catch (error) {
      if (!(await matches())) return unavailable();
      throw error;
    }
  }

  async function refreshHandle(handle: RegistryHandle): Promise<void> {
    if (!handle.refreshPromise) {
      handle.refreshPromise = handle.registryPromise
        .then(async (registry) => {
          await registry.refresh();
          handle.restartWatcher();
        })
        .finally(() => {
          handle.refreshPromise = undefined;
        });
    }
    return handle.refreshPromise;
  }

  return {
    async listSkills(input, installedHubMetadataByLocationUri) {
      return withAgentResourceScope(input, async (scopedInput) => {
        const agentName = normalizeAgentName(scopedInput.agentName);
        const handle = await getHandleForAgent(
          agentName,
          scopedInput.workspaceDir,
          scopedInput.compatibleAgentNames,
          scopedInput.excludeAgentResources,
          scopedInput.expectedAgentInstanceId,
        );
        const registry = await handle.registryPromise;
        const disabledLocationUris = await enabledState.getDisabledLocationUris();
        return listRegistrySkillSummaries(registry, {
          limit: scopedInput.limit,
          cursor: scopedInput.cursor,
          scope: scopedInput.scope,
          sourceType: scopedInput.sourceType,
          keyword: scopedInput.keyword,
          excludeBuiltin: scopedInput.excludeBuiltin,
          agentName,
          compatibleAgentNames: scopedInput.compatibleAgentNames,
          installedHubMetadataByLocationUri,
          disabledLocationUris,
          betaFlags: scopedInput.betaFlags,
        });
      });
    },
    async listRuntimeSkills(input = {}) {
      return withAgentResourceScope(input, async (scopedInput) => {
        const agentName = normalizeAgentName(scopedInput.agentName);
        const handle = await getHandleForAgent(
          agentName,
          scopedInput.workspaceDir,
          scopedInput.compatibleAgentNames,
          scopedInput.excludeAgentResources,
          scopedInput.expectedAgentInstanceId,
        );
        const registry = await handle.registryPromise;
        const [mcpServerNames, disabledLocationUris] = await Promise.all([
          readMcpServerNames(),
          enabledState.getDisabledLocationUris(),
        ]);
        return listRegistryRuntimeSkills(registry, {
          agentName,
          compatibleAgentNames: scopedInput.compatibleAgentNames,
          betaFlags: scopedInput.betaFlags,
          injectableBuiltinSkillNames: scopedInput.injectableBuiltinSkillNames,
          allowedSkillNames: scopedInput.allowedSkillNames,
          allowedExtensionSkillNames: scopedInput.allowedExtensionSkillNames,
          mcpServerNames,
          disabledLocationUris,
        });
      });
    },
    async renderCatalog(input = {}) {
      return withAgentResourceScope(input, async (scopedInput) => {
        const agentName = normalizeAgentName(scopedInput.agentName);
        const handle = await getHandleForAgent(
          agentName,
          scopedInput.workspaceDir,
          scopedInput.compatibleAgentNames,
          scopedInput.excludeAgentResources,
          scopedInput.expectedAgentInstanceId,
        );
        const registry = await handle.registryPromise;
        const [mcpServerNames, disabledLocationUris] = await Promise.all([
          readMcpServerNames(),
          enabledState.getDisabledLocationUris(),
        ]);
        return renderLocalRegistrySkillsCatalog(registry, {
          agentName,
          compatibleAgentNames: scopedInput.compatibleAgentNames,
          injectableBuiltinSkillNames: scopedInput.injectableBuiltinSkillNames,
          allowedSkillNames: scopedInput.allowedSkillNames,
          allowedExtensionSkillNames: scopedInput.allowedExtensionSkillNames,
          betaFlags: scopedInput.betaFlags,
          mcpServerNames,
          disabledLocationUris,
          contextWindowTokens: scopedInput.contextWindowTokens,
          additionalSkills: scopedInput.additionalSkills,
        });
      });
    },
    async readSkillByName(name, options = {}) {
      return withAgentResourceScope(options, async (scopedOptions) => {
        const agentName = normalizeAgentName(scopedOptions.agentName);
        const handle = await getHandleForAgent(
          agentName,
          scopedOptions.workspaceDir,
          scopedOptions.compatibleAgentNames,
          scopedOptions.excludeAgentResources,
          scopedOptions.expectedAgentInstanceId,
        );
        const registry = await handle.registryPromise;
        const [mcpServerNames, disabledLocationUris] = await Promise.all([
          readMcpServerNames(),
          enabledState.getDisabledLocationUris(),
        ]);
        return readRegistrySkillByName(registry, name, {
          agentName,
          compatibleAgentNames: scopedOptions.compatibleAgentNames,
          resourceAmbiguityTelemetry: scopedOptions.resourceAmbiguityTelemetry,
          disabledLocationUris,
          betaFlags: scopedOptions.betaFlags ?? inheritedRuntimeReadBetaFlags(registry),
          injectableBuiltinSkillNames: scopedOptions.injectableBuiltinSkillNames,
          allowedSkillNames: scopedOptions.allowedSkillNames,
          allowedExtensionSkillNames: scopedOptions.allowedExtensionSkillNames,
          mcpServerNames,
        });
      });
    },
    async getSkillDetail(input, options = {}) {
      return withAgentResourceScope(input, async (scopedInput) => {
        const handle = await resolveSkillHandle(scopedInput);
        if (!handle) return undefined;
        const registry = await handle.registryPromise;
        return getRegistrySkillDetail(registry, scopedInput, {
          ...options,
          disabledLocationUris: await enabledState.getDisabledLocationUris(),
        });
      });
    },
    async listSkillFiles(input) {
      return withAgentResourceScope(input, async (scopedInput) => {
        const handle = await resolveSkillHandle(scopedInput);
        if (!handle) return undefined;
        const registry = await handle.registryPromise;
        return listRegistrySkillFiles(registry, scopedInput);
      });
    },
    async readSkillFile(input) {
      return withAgentResourceScope(input, async (scopedInput) => {
        const handle = await resolveSkillHandle(scopedInput);
        if (!handle) return undefined;
        const registry = await handle.registryPromise;
        return readRegistrySkillFile(registry, scopedInput);
      });
    },
    async deleteSkill(input) {
      const handle = await resolveSkillHandle(input);
      if (!handle) return undefined;
      const registry = await handle.registryPromise;
      const identity = resolveRegistrySkillIdentity(registry, input);
      const deleted = await deleteRegistrySkill(registry, input);
      if (deleted && deleted !== 'protected') {
        if (identity) await enabledState.forget(identity.locationUri);
        await refreshHandle(handle);
      }
      return deleted;
    },
    async setSkillEnabled(input, enabled) {
      const handle = await resolveSkillHandle(input);
      if (!handle) return undefined;
      const registry = await handle.registryPromise;
      const identity = resolveRegistrySkillIdentity(registry, input);
      if (!identity) return undefined;
      await enabledState.setEnabled(identity.locationUri, enabled);
      return { ok: true, name: identity.name, enabled };
    },
    async refresh(input = {}) {
      const handle = await getHandleForAgent(input.agentName, input.workspaceDir);
      await refreshHandle(handle);
    },
  };
}

function createProcessLocalSkillEnabledState(): LocalSkillEnabledStatePort {
  const disabled = new Set<string>();
  return {
    getDisabledLocationUris: async () => new Set(disabled),
    setEnabled: async (locationUri, enabled) => {
      if (enabled) disabled.delete(locationUri);
      else disabled.add(locationUri);
    },
    forget: async (locationUri) => {
      disabled.delete(locationUri);
    },
  };
}
