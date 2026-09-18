import type { ChannelDeliveryPort, CronStorePort } from '@mavis/cron';

import {
  createLocalCronRuntime,
  buildLocalCronChannelDelivery,
  type LocalCronRuntime,
  type LocalCronRuntimeOptions,
} from '../cron/index.js';
import type { LocalApiAgentRoutes } from './routes/agents.js';
import type { LocalMessageQueueStore } from '../messages/queue.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type { ModuleMetricsReporter } from '../runtime/observability-host-wiring.js';
import type { LocalChannelRunner } from '../channels/runner.js';
import type { LocalChannelBridgeInfra } from '../channels/infra.js';
import type { LocalFeishuChannelApi } from '../channels/feishu.js';
import type { LocalTelegramChannelApi } from '../channels/telegram.js';
import type { LocalWeChatChannelApi } from '../channels/wechat.js';
import type { LocalRuntimeCapabilities, LocalRuntimeMode } from '../runtime/mode.js';
import type { LocalRuntimeStartupExecutionPolicy } from '../runtime/startup-execution-policy.js';

export interface HostCronRuntimeDeps {
  cronStore: CronStorePort;
  agentRoutes: LocalApiAgentRoutes;
  queueStore: LocalMessageQueueStore;
  sessionTurns: { has(sessionId: string): boolean };
  nowMs: () => number;
  agentName: string;
  resolveAgentReadScope?: (requestedName: string) => Promise<{
    canonicalName: string;
    compatibleNames?: readonly string[];
  }>;
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  resolveAgentExecutionTarget?: (exactOwnerName: string) => Promise<string>;
  channelRunner: LocalChannelRunner;
  channelBridgeInfra: LocalChannelBridgeInfra;
  feishuChannelApi: LocalFeishuChannelApi;
  telegramChannelApi: LocalTelegramChannelApi;
  wechatChannelApi: LocalWeChatChannelApi;
  configGetter: () => { dataDir: string };
  resolveDefaultWorkspaceDir: () => string;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  listAllSessions: LocalCronRuntimeOptions['listAllSessions'];
  updateSession: LocalCronRuntimeOptions['updateSession'];
  deleteSession: (sessionId: string) => Promise<void>;
  deleteMessageState: (sessionId: string) => Promise<void>;
  emitBusEvent: (type: string, payload: Record<string, unknown>) => void;
  lockOwner: { ownerKind: string; ownerId: string };
  runtimeMode: LocalRuntimeMode;
  capabilities: LocalRuntimeCapabilities;
}

export function buildHostCronRuntime(
  host: HostCronRuntimeDeps,
  runQueuedTurn: LocalCronRuntimeOptions['runQueuedTurn'],
  metricsReporter?: ModuleMetricsReporter,
  cronConsumerEnabled?: boolean,
  startupExecutionPolicy?: LocalRuntimeStartupExecutionPolicy,
): LocalCronRuntime {
  return createLocalCronRuntime({
    cronStore: host.cronStore,
    agentRoutes: host.agentRoutes,
    queueStore: host.queueStore,
    activePiTurns: host.sessionTurns,
    runQueuedTurn,
    nowMs: host.nowMs,
    dataDir: () => host.configGetter().dataDir,
    primaryAgentName: host.agentName,
    ...(host.resolveAgentReadScope ? { resolveAgentReadScope: host.resolveAgentReadScope } : {}),
    ...(host.resolveAgentWriteTarget
      ? { resolveAgentWriteTarget: host.resolveAgentWriteTarget }
      : {}),
    ...(host.resolveAgentExecutionTarget
      ? { resolveAgentExecutionTarget: host.resolveAgentExecutionTarget }
      : {}),
    resolveDefaultWorkspaceDir: () => host.resolveDefaultWorkspaceDir(),
    getSessionById: (id) => host.getSessionById(id),
    listAllSessions: (agentName, options) => host.listAllSessions(agentName, options),
    updateSession: (id, fields) => host.updateSession(id, fields),
    deleteSession: (id) => host.deleteSession(id),
    deleteMessageState: (id) => host.deleteMessageState(id),
    channelDelivery: buildHostCronChannelDelivery(host),
    emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
    runtimeOwnerKind: host.lockOwner.ownerKind,
    runtimeOwnerId: host.lockOwner.ownerId,
    runtimeMode: host.runtimeMode,
    capabilities: host.capabilities,
    startupExecutionPolicy,
    cronConsumerEnabled:
      cronConsumerEnabled ?? (host.lockOwner.ownerKind !== 'cli' && !host.capabilities.cliEmbedded),
    ...(metricsReporter ? { metricsReporter } : {}),
  });
}

export function startHostCronRuntime(
  runtime: LocalCronRuntime,
  emitBusEvent: HostCronRuntimeDeps['emitBusEvent'],
): void {
  if (!runtime.cronConsumerEnabled) return;
  void runtime.ensureStarted('host_init').catch((err: unknown) => {
    emitBusEvent('cron.startup_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function buildHostCronChannelDelivery(host: HostCronRuntimeDeps): ChannelDeliveryPort {
  return buildLocalCronChannelDelivery({
    runner: host.channelRunner,
    bindingStore: host.channelBridgeInfra.bindingStore,
    feishu: host.feishuChannelApi,
    telegram: host.telegramChannelApi,
    wechat: host.wechatChannelApi,
  });
}
