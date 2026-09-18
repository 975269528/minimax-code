import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readFirstString } from '../api/http-helpers.js';
import { LocalFeishuChannelStore, feishuClientId } from './feishu.js';
import { LocalTelegramChannelStore, telegramClientId } from './telegram.js';
import { LocalWeChatChannelStore, wechatClientId } from './wechat.js';
import {
  LocalChannelRouteStore,
  type ChannelPlatform,
  type ChannelRouteRule,
} from './route-api.js';
import type { LocalChannelBindingStore } from './infra.js';
import type { ObservabilityLogger } from '../observability/index.js';

/**
 * One-time forward-compatibility migrator for IM channel bindings.
 *
 * Older builds (tree-b `main` / `preview_train`) persisted per-agent IM
 * credentials as `<dataDir>/credentials/<agent>/{feishu,telegram,wechat}.json`.
 * The current local-runtime channel subsystem reads bindings from the
 * per-platform YAML stores (`feishu-channel.yaml`, `telegram-channel.yaml`,
 * `wechat-channel.yaml`) plus routing rules in `channel-routes.yaml`. This
 * migrator reads any legacy credential files present in the runtime's OWN
 * startup dataDir (source === target — an in-place format migration) and
 * upserts them into the current stores, then ensures a default route so
 * inbound messages resolve to the same agent.
 *
 * It is idempotent by construction: already-bound platforms are skipped, a
 * route is only created when no rule already targets that client, and the
 * legacy channel-binding pin fields are retained as opaque compatibility data.
 * The V2 Channel owner guards this narrow action with its one-time receipt so
 * the scan does not run on every boot.
 *
 * The historical reverted design (`legacy-feishu-migration.ts`, MR !3730)
 * covered Feishu only and relied on an Electron `imGateway` enrich bridge for
 * WeChat/Telegram; that bridge no longer exists in dev, so this rewrite
 * migrates all three platforms natively into the current stores instead.
 */

export interface LegacyImPlatformResult {
  /** Credentials newly bound into the current store. */
  migrated: number;
  /** Legacy files skipped (already bound / malformed / pending QR). */
  skipped: number;
  /** Default route rules newly created. */
  routesCreated: number;
}

export interface LegacyImMigrationSummary {
  feishu: LegacyImPlatformResult;
  telegram: LegacyImPlatformResult;
  wechat: LegacyImPlatformResult;
  /** Retained compatibility field; channel binding pins are no longer inspected. */
  sessionsPreserved: number;
  /** Retained compatibility field; channel binding pins are no longer rewritten. */
  sessionsDegraded: number;
}

/**
 * A credential-backed legacy route candidate. It deliberately carries no
 * credential material: V2 startup only needs the exact Agent/platform/client
 * identity in order to backfill its durable IM binding.
 */
export interface LegacyImCredentialCandidate {
  readonly key: string;
  readonly platform: ChannelPlatform;
  readonly agentName: string;
  readonly clientName: string;
}

export interface LegacyImMigrationOptions {
  /**
   * In-place migration root: the runtime's own startup dataDir. Legacy
   * credential files are read from `<dataDir>/credentials/<agent>/*.json` and
   * the current stores under the same dataDir are the migration target.
   */
  dataDir: string;
  defaultAgentName: string;
  nowMs: () => number;

  feishuStore: LocalFeishuChannelStore;
  telegramStore: LocalTelegramChannelStore;
  wechatStore: LocalWeChatChannelStore;

  /** Pre-loaded route store rooted at the same dataDir. */
  routeStore: LocalChannelRouteStore;
  /** Retained for startup compatibility; legacy pin state is not inspected. */
  bindingStore: LocalChannelBindingStore;

  /** Retained for startup compatibility; legacy pin state is not inspected. */
  sessionExists: (sessionId: string) => Promise<boolean>;

  observability: ObservabilityLogger;
}

/** Rule id + route target agentId charset (mirrors route-api.ts). */
const AGENT_ID_REGEX = /^[a-z0-9-]+$/u;

const PLATFORM_SESSION_TITLE: Record<ChannelPlatform, string> = {
  feishu: 'Feishu',
  telegram: 'Telegram',
  wechat: 'WeChat',
};

function emptyResult(): LegacyImPlatformResult {
  return { migrated: 0, skipped: 0, routesCreated: 0 };
}

/**
 * Reuses the legacy credential decoder to enumerate only valid historical
 * credential files. The marker can already be set when a prior build copied
 * credentials but never created a V2 physical Binding, so callers may safely
 * invoke this on every bounded V2 startup repair pass.
 */
export async function listLegacyImCredentialCandidates(
  dataDir: string,
): Promise<LegacyImCredentialCandidate[]> {
  const candidates: LegacyImCredentialCandidate[] = [];
  for (const agentName of await listAgentDirs(dataDir)) {
    for (const platform of ['feishu', 'telegram', 'wechat'] as const) {
      const credential = await readLegacyCredential(dataDir, agentName, platform);
      if (!isUsableLegacyCredential(platform, credential)) continue;
      candidates.push({
        key: `legacy-credential:${platform}:${clientNameForLegacyCredential(platform, agentName)}`,
        platform,
        agentName,
        clientName: clientNameForLegacyCredential(platform, agentName),
      });
    }
  }
  return candidates;
}

/**
 * Run the migration. Pure with respect to process env and receipt handling,
 * so it is directly
 * unit-testable and safe to invoke repeatedly.
 */
export async function migrateLegacyImCredentialsIfNeeded(
  options: LegacyImMigrationOptions,
): Promise<LegacyImMigrationSummary> {
  const feishu = emptyResult();
  const telegram = emptyResult();
  const wechat = emptyResult();

  for (const agent of await listAgentDirs(options.dataDir)) {
    await migrateFeishu(options, agent, feishu);
    await migrateTelegram(options, agent, telegram);
    await migrateWeChat(options, agent, wechat);
  }

  const { preserved, degraded } = await repairPinnedSessions(options);

  return {
    feishu,
    telegram,
    wechat,
    sessionsPreserved: preserved,
    sessionsDegraded: degraded,
  };
}

async function listAgentDirs(dataDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(dataDir, 'credentials'), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Read + parse a legacy credential file, flattening the older nested
 * `{ platform, credentials: {...}, updatedAt }` shape into a single record so
 * both the flat (Feishu) and nested (Telegram/WeChat) layouts read uniformly.
 */
async function readLegacyCredential(
  dataDir: string,
  agent: string,
  platform: ChannelPlatform,
): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, 'credentials', agent, `${platform}.json`), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  const nested = obj.credentials;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { ...obj, ...(nested as Record<string, unknown>) };
  }
  return obj;
}

function isUsableLegacyCredential(
  platform: ChannelPlatform,
  credential: Record<string, unknown> | undefined,
): boolean {
  if (!credential) return false;
  if (platform === 'feishu') {
    return Boolean(
      readFirstString(credential, ['appId', 'app_id']) &&
      readFirstString(credential, ['appSecret', 'app_secret']),
    );
  }
  const botToken = readFirstString(credential, ['botToken', 'bot_token', 'token']);
  return Boolean(botToken && (platform !== 'wechat' || !botToken.startsWith('pending:')));
}

function clientNameForLegacyCredential(platform: ChannelPlatform, agentName: string): string {
  if (platform === 'feishu') return feishuClientId(agentName);
  if (platform === 'telegram') return telegramClientId(agentName);
  return wechatClientId(agentName);
}

async function migrateFeishu(
  options: LegacyImMigrationOptions,
  agent: string,
  result: LegacyImPlatformResult,
): Promise<void> {
  const cred = await readLegacyCredential(options.dataDir, agent, 'feishu');
  if (!cred) return;
  const appId = readFirstString(cred, ['appId', 'app_id']);
  const appSecret = readFirstString(cred, ['appSecret', 'app_secret']);
  if (!appId || !appSecret) {
    result.skipped += 1;
    options.observability.warn('channel.legacy_im_migration.feishu.malformed', {
      agent_name: agent,
    });
    return;
  }
  if (await options.feishuStore.get(agent)) {
    result.skipped += 1;
  } else {
    const body: Record<string, unknown> = { agentName: agent, appId, appSecret };
    const verificationToken = readFirstString(cred, [
      'verificationToken',
      'verification_token',
      'token',
    ]);
    const encryptKey = readFirstString(cred, [
      'encryptKey',
      'encrypt_key',
      'encryptToken',
      'encrypt_token',
    ]);
    const botName = readFirstString(cred, ['botName', 'bot_name']);
    // Legacy im_gateway credentials have no local transport concept; migrated
    // Feishu bots must connect via the local WebSocket. Only honor an explicit
    // legacy webhook/websocket value, otherwise force websocket so the record
    // never falls back to 'mock' (which host-channels-lifecycle silently skips).
    const mode = readFirstString(cred, ['mode']);
    if (verificationToken) body.verificationToken = verificationToken;
    if (encryptKey) body.encryptKey = encryptKey;
    if (botName) body.botName = botName;
    body.mode = mode === 'webhook' || mode === 'websocket' ? mode : 'websocket';
    await options.feishuStore.bind({
      agentName: agent,
      appId,
      appSecret,
      ...(typeof body.verificationToken === 'string'
        ? { verificationToken: body.verificationToken }
        : {}),
      ...(typeof body.encryptKey === 'string' ? { encryptKey: body.encryptKey } : {}),
      ...(typeof body.botName === 'string' ? { botName: body.botName } : {}),
      mode: body.mode as 'webhook' | 'websocket',
      suppressFamilyMutation: true,
    });
    result.migrated += 1;
  }
  await ensureRoute(options, 'feishu', agent, feishuClientId(agent), result);
}

async function migrateTelegram(
  options: LegacyImMigrationOptions,
  agent: string,
  result: LegacyImPlatformResult,
): Promise<void> {
  const cred = await readLegacyCredential(options.dataDir, agent, 'telegram');
  if (!cred) return;
  const botToken = readFirstString(cred, ['botToken', 'bot_token', 'token']);
  if (!botToken) {
    result.skipped += 1;
    options.observability.warn('channel.legacy_im_migration.telegram.malformed', {
      agent_name: agent,
    });
    return;
  }
  if (await options.telegramStore.get(agent)) {
    result.skipped += 1;
  } else {
    // Bind offline via the store: the API's bind() performs a live getMe
    // network call, which must never run at startup migration time.
    await options.telegramStore.bind({
      agentName: agent,
      botToken,
      botName: readFirstString(cred, ['botName', 'bot_name', 'username']),
      mode: 'sdk',
      suppressFamilyMutation: true,
    });
    result.migrated += 1;
  }
  await ensureRoute(options, 'telegram', agent, telegramClientId(agent), result);
}

async function migrateWeChat(
  options: LegacyImMigrationOptions,
  agent: string,
  result: LegacyImPlatformResult,
): Promise<void> {
  const cred = await readLegacyCredential(options.dataDir, agent, 'wechat');
  if (!cred) return;
  const botToken = readFirstString(cred, ['botToken', 'bot_token', 'token']);
  // Best-effort: an un-scanned QR bind (`pending:<session>`) carries no real
  // credential, so there is nothing durable to migrate.
  if (!botToken || botToken.startsWith('pending:')) {
    result.skipped += 1;
    options.observability.warn('channel.legacy_im_migration.wechat.pending_skipped', {
      agent_name: agent,
    });
    return;
  }
  const existing = await options.wechatStore.get(agent);
  if (existing?.botToken && !existing.botToken.startsWith('pending:')) {
    result.skipped += 1;
  } else {
    await options.wechatStore.bind({
      agentName: agent,
      botToken,
      ilinkBotId: readFirstString(cred, ['ilinkBotId', 'ilink_bot_id']),
      baseUrl: readFirstString(cred, ['baseUrl', 'base_url']),
      webhookToken: readFirstString(cred, ['webhookToken', 'webhook_token']),
      botName: readFirstString(cred, ['botName', 'bot_name']),
      mode: 'polling',
      connected: true,
      suppressFamilyMutation: true,
    });
    result.migrated += 1;
  }
  await ensureRoute(options, 'wechat', agent, wechatClientId(agent), result);
}

/**
 * Ensure a default route rule exists so inbound messages for `clientId`
 * resolve to `agent`. Idempotent: skips when a rule already targets that
 * clientName, and treats a duplicate-id 409 as a no-op.
 */
async function ensureRoute(
  options: LegacyImMigrationOptions,
  platform: ChannelPlatform,
  agent: string,
  clientId: string,
  result: LegacyImPlatformResult,
): Promise<void> {
  if (!AGENT_ID_REGEX.test(agent)) {
    // Rule id + target agentId share this charset; a non-conforming agent name
    // cannot form a valid rule. The binding itself still succeeded.
    options.observability.warn(
      `channel.legacy_im_migration.${platform}.route_skipped_invalid_agent`,
      {
        agent_name: agent,
      },
    );
    return;
  }
  if (options.routeStore.getRules(platform).some((rule) => rule.match.clientName === clientId)) {
    return;
  }
  const now = options.nowMs();
  const rule: ChannelRouteRule = {
    id: `legacy-${platform}-${agent}`,
    platform,
    match: { chatType: '*', chatId: '', senderId: '', clientName: clientId },
    target: {
      agentId: agent,
      sessionStrategy: 'root',
      sessionTitle: PLATFORM_SESSION_TITLE[platform],
      exactOwnerName: agent,
      projectKey: 'default',
      routingMode: 'project-main',
      generation: 0,
    },
    enabled: true,
    priority: 100,
    createdAt: now,
    updatedAt: now,
  };
  const added = await options.routeStore.addRule(rule);
  if ('error' in added) {
    // 409 = id already exists (idempotent no-op). Anything else is a real
    // rejection worth surfacing.
    if (added.error.status === 409) return;
    throw new Error(`Legacy ${platform} route migration rejected for agent ${agent}`);
  }
  result.routesCreated += 1;
}

/**
 * Legacy pin compatibility no-op. The persisted binding field is intentionally
 * not read or rewritten now that route resolution ignores it.
 */
async function repairPinnedSessions(
  options: LegacyImMigrationOptions,
): Promise<{ preserved: number; degraded: number }> {
  void options;
  return { preserved: 0, degraded: 0 };
}
