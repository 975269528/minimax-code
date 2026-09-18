import { getRuntimeBuildEnv, getRuntimeRegion } from '@mavis/config';
import {
  BoundedInternalTurnPromptReadRegistry,
  type InternalTurnPromptReadRegistry,
  type PromptSnapshotSource,
} from '@mavis/agent-runtime';

import type { PromptFileReader } from '../contracts.js';
import { initializeManagedDesktopPromptConfig } from '../initialize.js';
import type { PromptConfigService } from '../prompt-config.service.js';
import type { PromptConfigRuntimeAuthContext } from './runtime-auth.js';
import type { LocalPromptFileReader } from '../storage/prompt-file-reader.js';

export interface RuntimePromptConfigComposition {
  readonly snapshots: PromptSnapshotSource;
  ready(): Promise<void>;
  close(): Promise<void>;
  notifyAuthContextChanged(): void;
}

export interface RuntimePromptSupport {
  readonly promptConfig: RuntimePromptConfigComposition | undefined;
  readonly promptSnapshots: PromptSnapshotSource | undefined;
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
}

interface RuntimePromptConfigPluginPort {
  readonly authContextGetter: () => PromptConfigRuntimeAuthContext | undefined;
  readonly fetchImpl: typeof fetch;
  readonly appVersion?: string;
}

interface RuntimePromptConfigBindings {
  readonly promptSnapshots: {
    bind(source: PromptSnapshotSource | undefined): void;
  };
  readonly internalTurnPromptReads: {
    bind(registry: InternalTurnPromptReadRegistry | undefined): void;
  };
}

interface RuntimePromptConfigAgentBinding {
  bindPromptConfig(promptConfig: Pick<PromptConfigService, 'capture' | 'captureBuiltin'>): void;
}

interface RuntimePromptSnapshotFactory {
  create(input: {
    readonly config: Pick<PromptConfigService, 'capture' | 'captureBuiltin'>;
    readonly reader: PromptFileReader;
    readonly managedKeys: ReadonlySet<string>;
  }): PromptSnapshotSource;
}

/** Composes the Desktop Prompt control plane without leaking it into runtime.ts. */
async function initializeRuntimePromptConfig(input: {
  readonly enabled: boolean;
  readonly dataDir: string;
  readonly promptConfigKey?: Uint8Array;
  readonly plugin: RuntimePromptConfigPluginPort;
  readonly agentService: RuntimePromptConfigAgentBinding;
  readonly snapshotFactory: RuntimePromptSnapshotFactory;
  readonly promptFileReader?: LocalPromptFileReader;
}): Promise<RuntimePromptConfigComposition | undefined> {
  const managed = await initializeManagedDesktopPromptConfig({
    enabled: input.enabled,
    dataDir: input.dataDir,
    ...(input.promptConfigKey ? { desktopKey: input.promptConfigKey } : {}),
    authContextGetter: input.plugin.authContextGetter,
    deploymentGetter: () => `${getRuntimeRegion()}-${getRuntimeBuildEnv()}`,
    fetchImpl: input.plugin.fetchImpl,
    ...(input.plugin.appVersion ? { appVersion: input.plugin.appVersion } : {}),
    ...(input.promptFileReader ? { reader: input.promptFileReader } : {}),
  });
  if (!managed) return undefined;

  input.agentService.bindPromptConfig(managed.owner.service);
  const snapshots = input.snapshotFactory.create({
    config: managed.owner.service,
    reader: managed.owner.reader,
    managedKeys: managed.managedPaths,
  });
  return {
    snapshots,
    ready: () => managed.owner.service.ready(),
    close: () => managed.owner.service.close(),
    notifyAuthContextChanged: () => {
      managed.auth.authContextChanged();
      queueMicrotask(() => void managed.owner.service.authContextChanged());
    },
  };
}

export async function initializeRuntimePromptSupport(input: {
  readonly enabled: boolean;
  readonly dataDir: string;
  readonly promptConfigKey?: Uint8Array;
  readonly plugin: RuntimePromptConfigPluginPort;
  readonly agentService: RuntimePromptConfigAgentBinding;
  readonly snapshotFactory: RuntimePromptSnapshotFactory;
  readonly promptFileReader?: LocalPromptFileReader;
}): Promise<RuntimePromptSupport> {
  const internalTurnPromptReads = new BoundedInternalTurnPromptReadRegistry();
  try {
    const promptConfig = await initializeRuntimePromptConfig(input);
    return {
      promptConfig,
      promptSnapshots: promptConfig?.snapshots,
      internalTurnPromptReads,
    };
  } catch (error) {
    internalTurnPromptReads.close();
    throw error;
  }
}

export async function withRuntimePromptSupportRollback<T>(
  support: RuntimePromptSupport,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await closeUnboundRuntimePromptSupport(support);
    throw error;
  }
}

export function bindRuntimePromptSupport(
  bindings: RuntimePromptConfigBindings,
  support: RuntimePromptSupport,
): void {
  bindings.promptSnapshots.bind(support.promptSnapshots);
  bindings.internalTurnPromptReads.bind(support.internalTurnPromptReads);
}

export function createRuntimePromptLifecycle(input: {
  readonly promptConfig: RuntimePromptConfigComposition | undefined;
  readonly lifecycle: { ready(): Promise<void>; close(): Promise<void> };
  readonly bindings: RuntimePromptConfigBindings;
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
}): { ready(): Promise<void>; close(): Promise<void> } {
  let readyPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  return {
    ready: () => {
      readyPromise ??= readyRuntimePromptLifecycle(input);
      return readyPromise;
    },
    close: () => {
      closePromise ??= closeRuntimePromptLifecycle(input);
      return closePromise;
    },
  };
}

async function readyRuntimePromptLifecycle(input: {
  readonly promptConfig: RuntimePromptConfigComposition | undefined;
  readonly lifecycle: { ready(): Promise<void> };
}): Promise<void> {
  await input.promptConfig?.ready();
  await input.lifecycle.ready();
}

async function closeRuntimePromptLifecycle(input: {
  readonly promptConfig: RuntimePromptConfigComposition | undefined;
  readonly lifecycle: { close(): Promise<void> };
  readonly bindings: RuntimePromptConfigBindings;
  readonly internalTurnPromptReads: InternalTurnPromptReadRegistry;
}): Promise<void> {
  let lifecycleFailure: unknown;
  try {
    await input.lifecycle.close();
  } catch (error) {
    lifecycleFailure = error;
  }
  input.bindings.promptSnapshots.bind(undefined);
  input.bindings.internalTurnPromptReads.bind(undefined);
  input.internalTurnPromptReads.close();
  let promptFailure: unknown;
  try {
    await input.promptConfig?.close();
  } catch (error) {
    promptFailure = error;
  }
  if (lifecycleFailure) throw lifecycleFailure;
  if (promptFailure) throw promptFailure;
}

async function closeUnboundRuntimePromptSupport(support: RuntimePromptSupport): Promise<void> {
  support.internalTurnPromptReads.close();
  try {
    await support.promptConfig?.close();
  } catch {
    // Preserve the startup failure that made this support unreachable.
  }
}
