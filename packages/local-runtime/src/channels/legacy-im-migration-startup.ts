import { imLogger as logger } from '../common/im-logger.js';
import { NOOP_OBSERVABILITY_LOGGER } from '../observability/index.js';
import type { LocalChannelBindingStore } from './infra.js';
import { LocalFeishuChannelStore } from './feishu.js';
import { LocalTelegramChannelStore } from './telegram.js';
import { LocalWeChatChannelStore } from './wechat.js';
import { LocalChannelRouteStore } from './route-api.js';
import { migrateLegacyImCredentialsIfNeeded } from './legacy-im-migration.js';

/**
 * Narrow V1 executor for importing legacy credential files into channel state.
 * Receipt and retry policy belong to the V2 Channel owner.
 */
export async function migrateLegacyImCredentialsOnStartup(input: {
  dataDir: () => string;
  nowMs: () => number;
  agentName: string;
  feishuStore: LocalFeishuChannelStore;
  telegramStore: LocalTelegramChannelStore;
  wechatStore: LocalWeChatChannelStore;
  bindingStore: LocalChannelBindingStore;
  getSessionById: (sessionId: string) => Promise<unknown>;
}): Promise<void> {
  const dataDir = input.dataDir();
  const routeStore = await LocalChannelRouteStore.load(dataDir, input.agentName, input.nowMs);
  const summary = await migrateLegacyImCredentialsIfNeeded({
    dataDir,
    defaultAgentName: input.agentName,
    nowMs: input.nowMs,
    feishuStore: input.feishuStore,
    telegramStore: input.telegramStore,
    wechatStore: input.wechatStore,
    routeStore,
    bindingStore: input.bindingStore,
    sessionExists: async (id) => Boolean(await input.getSessionById(id)),
    observability: NOOP_OBSERVABILITY_LOGGER,
  });
  logger.info({ summary }, 'legacy IM credential migration completed');
}
