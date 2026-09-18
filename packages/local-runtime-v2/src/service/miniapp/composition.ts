import { join } from 'node:path';

import type { AppDb } from '../../infra/db/client.js';
import type { HostProcessConnectorGateway } from '../host-connector-system/index.js';
import type { MiniAppCandidate, MiniAppSupervisor } from './contracts.js';
import {
  initializeMiniAppSupervisor,
  type InitializeMiniAppSupervisorOptions,
} from './initialize.js';

export type RuntimeMiniAppOptions = Omit<
  InitializeMiniAppSupervisorOptions,
  | 'db'
  | 'connectorGateway'
  | 'verifyCandidate'
  | 'materializePackage'
  | 'resolvePluginDataDir'
  | 'nowMs'
>;

export interface RuntimeMiniAppServices {
  readonly miniApp?: MiniAppSupervisor;
}

export interface RuntimeMiniAppServiceOptions {
  readonly miniApp?: RuntimeMiniAppOptions;
}

export function resolveRuntimeMiniAppOptions(
  input: RuntimeMiniAppServiceOptions & { readonly runtimeOwnerKind?: string },
): RuntimeMiniAppOptions | undefined {
  if (input.runtimeOwnerKind !== undefined && input.runtimeOwnerKind !== 'electron') {
    return undefined;
  }
  if (input.miniApp) return input.miniApp;
  return input.runtimeOwnerKind === 'electron' ? {} : undefined;
}

export function createDeferredRuntimeOwnersLifecycle(): {
  readonly ready: () => Promise<void>;
  readonly close: () => Promise<void>;
  bind(lifecycle: {
    readonly ready: () => Promise<void>;
    readonly close: () => Promise<void>;
  }): void;
} {
  let lifecycle:
    | { readonly ready: () => Promise<void>; readonly close: () => Promise<void> }
    | undefined;
  const requireLifecycle = () => {
    if (!lifecycle) throw new Error('Runtime owner lifecycle is not bound');
    return lifecycle;
  };
  return {
    ready: () => requireLifecycle().ready(),
    close: () => requireLifecycle().close(),
    bind(next) {
      if (lifecycle) throw new Error('Runtime owner lifecycle is already bound');
      lifecycle = next;
    },
  };
}

/** Narrow Plugin publication capability consumed only by MiniApp Host composition. */
export interface MiniAppPluginPublicationCapability {
  readonly hostConnectorGateway: HostProcessConnectorGateway;
  attachMiniAppPublication(input: { readonly supervisor: MiniAppSupervisor }): void;
  verifyMiniAppCandidate(candidate: MiniAppCandidate): Promise<boolean>;
  materializeMiniAppRuntimePackage(input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
  }): Promise<void>;
}

/** Owns optional Supervisor initialization and ordered shutdown at the Host composition boundary. */
export async function composeMiniAppRuntimeCapability(input: {
  readonly options: RuntimeMiniAppOptions | undefined;
  readonly db: AppDb;
  readonly dataDir: string;
  readonly nowMs: () => number;
  readonly plugin: MiniAppPluginPublicationCapability;
  readonly readyOwners: () => Promise<void>;
  readonly closeOwners: () => Promise<void>;
}): Promise<{
  readonly services: RuntimeMiniAppServices;
  readonly ready: () => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  let miniApp: MiniAppSupervisor | undefined;
  try {
    if (input.options) {
      miniApp = initializeMiniAppSupervisor({
        ...input.options,
        db: input.db,
        connectorGateway: input.plugin.hostConnectorGateway,
        verifyCandidate: (candidate) => input.plugin.verifyMiniAppCandidate(candidate),
        materializePackage: (materialization) =>
          input.plugin.materializeMiniAppRuntimePackage(materialization),
        // Plugin-authored context.dataDir is persistent state. Keep the shipped physical root.
        resolvePluginDataDir: (pluginId) =>
          join(input.dataDir, 'v2', 'plugin-data', 'liveboards', encodeURIComponent(pluginId)),
        nowMs: input.nowMs,
      });
      input.plugin.attachMiniAppPublication({ supervisor: miniApp });
    }
  } catch (error) {
    await closeAfterInitializationFailure(miniApp, input.closeOwners);
    throw error;
  }
  return {
    services: miniApp ? { miniApp } : {},
    ready: createCombinedReady(miniApp, input.readyOwners),
    close: createCombinedClose(input.closeOwners, miniApp),
  };
}

function createCombinedReady(
  miniApp: MiniAppSupervisor | undefined,
  readyOwners: () => Promise<void>,
): () => Promise<void> {
  let readyPromise: Promise<void> | undefined;
  return () => {
    readyPromise ??= readyMiniAppAfterOwners(miniApp, readyOwners);
    return readyPromise;
  };
}

async function readyMiniAppAfterOwners(
  miniApp: MiniAppSupervisor | undefined,
  readyOwners: () => Promise<void>,
): Promise<void> {
  await readyOwners();
  await miniApp?.ready();
}

async function closeAfterInitializationFailure(
  miniApp: MiniAppSupervisor | undefined,
  closeOwners: () => Promise<void>,
) {
  for (const close of [closeOwners, () => miniApp?.close()]) {
    try {
      await close();
    } catch {
      // Preserve the initialization error after best-effort cleanup of acquired owners.
    }
  }
}

function createCombinedClose(
  closeOwners: () => Promise<void>,
  miniApp: MiniAppSupervisor | undefined,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    closePromise ??= closeOwnersAndMiniApp(closeOwners, miniApp);
    return closePromise;
  };
}

async function closeOwnersAndMiniApp(
  closeOwners: () => Promise<void>,
  miniApp: MiniAppSupervisor | undefined,
): Promise<void> {
  let firstError: unknown;
  try {
    await closeOwners();
  } catch (error) {
    firstError = error;
  }
  try {
    await miniApp?.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError) throw firstError;
}
