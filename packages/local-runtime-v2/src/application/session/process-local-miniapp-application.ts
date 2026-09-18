import type { MiniAppSurfaceSummary } from '@mavis/shared/miniapp-surface';

import {
  miniAppBusyReason,
  type MiniAppStatus,
  type MiniAppSupervisor,
} from '../../service/miniapp/index.js';
import type {
  AvailableMiniAppDefinition,
  MiniAppPluginControl,
} from '../../service/plugin-system/index.js';
import type {
  LocalRuntimeApplication,
  ProcessLocalMiniAppLaunch,
} from './process-local-application-contract.js';

type ProcessLocalMiniAppApplication = NonNullable<LocalRuntimeApplication['miniApps']>;

/** Projects installed MiniApp definitions and Supervisor state for the Electron bridge. */
export function createProcessLocalMiniAppApplication(
  plugins: MiniAppPluginControl,
  supervisor: Pick<MiniAppSupervisor, 'inspect'> | undefined,
): ProcessLocalMiniAppApplication | undefined {
  if (!supervisor) return undefined;

  const requireDefinition = async (pluginId: string): Promise<AvailableMiniAppDefinition> => {
    const miniApp = (await plugins.listAvailableMiniApps()).find(
      (candidate) => candidate.pluginId === pluginId,
    );
    if (!miniApp) throw applicationError('NOT_FOUND');
    return miniApp;
  };

  const launch = (
    miniApp: AvailableMiniAppDefinition,
    status: MiniAppStatus | undefined,
  ): ProcessLocalMiniAppLaunch => {
    const active = status?.active;
    if (
      status?.phase !== 'active' ||
      !active?.origin ||
      !active.processGeneration ||
      active.pluginId !== miniApp.pluginId
    ) {
      throw applicationError(status?.failureCode ?? 'RUNTIME_FAILED');
    }
    return {
      miniApp: summary(miniApp, status),
      launch: {
        origin: active.origin,
        surfacePath: active.surfacePath,
        runId: active.processGeneration,
      },
    };
  };

  const open = async (
    pluginId: string,
    signal?: AbortSignal,
  ): Promise<ProcessLocalMiniAppLaunch> => {
    signal?.throwIfAborted();
    const miniApp = await requireDefinition(pluginId);
    try {
      await plugins.activateMiniApp({ pluginId, ...(signal ? { signal } : {}) });
    } catch (error) {
      const busyReason = miniAppBusyReason(error);
      if (!busyReason) throw error;
      throw Object.assign(applicationError('BUSY', { cause: error }), { busyReason });
    }
    signal?.throwIfAborted();
    return launch(miniApp, supervisor.inspect(pluginId)[0]);
  };

  return {
    list: async () => {
      const definitions = await plugins.listAvailableMiniApps();
      const statuses = new Map(supervisor.inspect().map((status) => [status.pluginId, status]));
      return {
        miniApps: definitions.map((miniApp) => summary(miniApp, statuses.get(miniApp.pluginId))),
      };
    },
    open: ({ pluginId, signal }) => open(pluginId, signal),
    stop: async ({ pluginId, signal }) => {
      await requireDefinition(pluginId);
      await plugins.stopMiniApp({ pluginId, ...(signal ? { signal } : {}) });
    },
  };
}

function summary(
  miniApp: AvailableMiniAppDefinition,
  status: MiniAppStatus | undefined,
): MiniAppSurfaceSummary {
  const runtimeStatus = mapRuntimeStatus(status?.phase);
  return {
    pluginId: miniApp.pluginId,
    ...(miniApp.displayName ? { displayName: miniApp.displayName } : {}),
    ...(miniApp.description ? { description: miniApp.description } : {}),
    ...(miniApp.iconPath ? { iconUrl: localIconUrl(miniApp.iconPath) } : {}),
    runtime: {
      kind: 'process',
      status: runtimeStatus,
      ...(runtimeStatus === 'failed' && status?.failureCode
        ? { errorCode: status.failureCode }
        : {}),
    },
  };
}

function localIconUrl(iconPath: string): string {
  return `/mavis/api/file/preview?path=${encodeURIComponent(iconPath)}`;
}

function mapRuntimeStatus(
  phase: MiniAppStatus['phase'] | undefined,
): MiniAppSurfaceSummary['runtime']['status'] {
  if (phase === 'active') return 'running';
  if (phase === 'starting' || phase === 'preparing') return 'starting';
  if (phase === 'failed' || phase === 'quarantined') return 'failed';
  return 'stopped';
}

function applicationError(code: string, options?: ErrorOptions): Error & { readonly code: string } {
  return Object.assign(new Error('Mini App surface action failed', options), { code });
}
