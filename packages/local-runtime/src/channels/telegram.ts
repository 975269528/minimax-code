import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import type { LocalChannelContext } from './infra.js';
import { json, readFirstString, readJsonBody } from '../api/http-helpers.js';
import {
  LocalChannelClientUnavailableError,
  type LocalChannelOutboundStore,
  type LocalChannelOutboundMessage,
  type LocalChannelRunner,
  type LocalMultiChannelClient,
} from './runner.js';
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from './envelope.js';
import type { LocalChannelOwnerStore } from './owner-store.js';
import { clearOwnerAllConventions } from './owner-store.js';
import type {
  ChannelFamilyMutationHook,
  ChannelFamilyMutationKind,
} from './channel-family-mutation.js';
import type { LocalMessageAttachment } from '../messages/input.js';
import type { OutboundMediaRef } from '@mavis/shared';
import type { AskQuestionnaireRequest } from '@mavis/shared/questionnaire';
import { prepareChannelOutboundMessage } from './outbound-message.js';
import {
  TelegramAttachmentDownloader,
  pickLargestPhoto,
  type TelegramAttachmentKind,
} from './adapters/telegram/telegram-attachment-downloader.js';
import type { TelegramPlatformAdapter } from './adapters/telegram/telegram-adapter.js';
import { sendTelegramQuestionnaireFallback } from './adapters/telegram/telegram-questionnaire-legacy-delivery.js';
import { TelegramSender } from './adapters/telegram/telegram-sender.js';
import { imLogger as logger } from '../common/im-logger.js';

export interface LocalTelegramBindingRecord {
  clientId: string;
  agentName: string;
  botToken: string;
  botName?: string;
  connected: boolean;
  enabled: boolean;
  mode: 'mock' | 'sdk';
  createdAt: number;
  updatedAt: number;
}

/** A persisted disabled or disconnected SDK row is not a transport credential. */
export function isUsableTelegramBinding(
  record: LocalTelegramBindingRecord | undefined,
): record is LocalTelegramBindingRecord & {
  enabled: true;
  connected: true;
  mode: 'sdk';
} {
  if (!record?.enabled || !record.connected || record.mode !== 'sdk') return false;
  return Boolean(record.botToken.trim());
}

interface LocalTelegramChannelFile {
  schemaVersion: number;
  bindings: Record<string, LocalTelegramBindingRecord>;
}

export type LocalTelegramEnvelope = ChannelInboundEnvelope;

export class LocalTelegramChannelStore {
  private loaded = false;
  private readonly bindings = new Map<string, LocalTelegramBindingRecord>();
  private familyHook: ChannelFamilyMutationHook | undefined;

  constructor(
    private readonly dataDir: () => string,
    private readonly nowMs: () => number,
  ) {}

  /** Install the shared primary-family write seam (plan §5.2). */
  setFamilyMutationHook(hook: ChannelFamilyMutationHook | undefined): void {
    this.familyHook = hook;
  }

  /** True only while the host has installed a trusted primary-family hook. */
  async isPrimaryFamilyAgent(
    agentName: string,
    kind: ChannelFamilyMutationKind = 'bind',
  ): Promise<boolean> {
    return (await this.familyHook?.isPrimaryFamilyAgent(agentName.trim(), kind)) === true;
  }

  async bind(input: {
    agentName: string;
    botToken: string;
    botName?: string;
    mode?: 'sdk';
    /** Internal state-only import: persist without invoking the live family hook. */
    suppressFamilyMutation?: boolean;
  }): Promise<LocalTelegramBindingRecord> {
    await this.load();
    const agentName = input.agentName.trim();
    const clientId = telegramClientId(agentName);
    const existing = this.bindings.get(clientId);
    const now = this.nowMs();
    // Staged disabled for the primary family — see `feishu.ts` bind().
    const primaryFamily =
      input.suppressFamilyMutation !== true && (await this.isPrimaryFamilyAgent(agentName));
    const record: LocalTelegramBindingRecord = {
      clientId,
      agentName,
      botToken: input.botToken.trim(),
      ...(input.botName?.trim() ? { botName: input.botName.trim() } : {}),
      connected: true,
      enabled: !primaryFamily,
      mode: input.mode ?? 'sdk',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.bindings.set(clientId, record);
    await this.save();
    if (primaryFamily) {
      await this.familyHook?.afterMutation({ agentName, kind: 'bind' });
    }
    return { ...(this.bindings.get(clientId) ?? record) };
  }

  async unbind(
    agentName: string,
    options?: { suppressFamilyMutation?: boolean },
  ): Promise<boolean> {
    await this.load();
    const trimmed = agentName.trim();
    const existing = this.bindings.get(telegramClientId(trimmed));
    const deleted = this.bindings.delete(telegramClientId(trimmed));
    if (deleted) await this.save();
    if (
      existing &&
      deleted &&
      options?.suppressFamilyMutation !== true &&
      (await this.isPrimaryFamilyAgent(trimmed, 'unbind')) === true
    ) {
      const identity = existing.botToken.trim();
      await this.familyHook?.afterMutation({
        agentName: trimmed,
        kind: 'unbind',
        unbound: { enabled: existing.enabled, ...(identity ? { identity } : {}) },
      });
    }
    return deleted;
  }

  /** Copy one binding's whole credential group onto another agentName. */
  async cloneBindingForAgent(input: {
    fromAgentName: string;
    toAgentName: string;
    enabled: boolean;
  }): Promise<LocalTelegramBindingRecord | undefined> {
    await this.load();
    const source = this.bindings.get(telegramClientId(input.fromAgentName.trim()));
    if (!source) return undefined;
    const toAgentName = input.toAgentName.trim();
    const clientId = telegramClientId(toAgentName);
    const existing = this.bindings.get(clientId);
    const record: LocalTelegramBindingRecord = {
      ...source,
      clientId,
      agentName: toAgentName,
      enabled: input.enabled,
      createdAt: existing?.createdAt ?? source.createdAt,
      updatedAt: this.nowMs(),
    };
    this.bindings.set(clientId, record);
    await this.save();
    return { ...record };
  }

  /** Flip one record's `enabled` flag without touching its credentials. */
  async setEnabled(
    agentName: string,
    enabled: boolean,
  ): Promise<LocalTelegramBindingRecord | undefined> {
    await this.load();
    const clientId = telegramClientId(agentName.trim());
    const existing = this.bindings.get(clientId);
    if (!existing) return undefined;
    if (existing.enabled === enabled) return { ...existing };
    const record: LocalTelegramBindingRecord = { ...existing, enabled, updatedAt: this.nowMs() };
    this.bindings.set(clientId, record);
    await this.save();
    return { ...record };
  }

  async get(agentName: string): Promise<LocalTelegramBindingRecord | undefined> {
    await this.load();
    const record = this.bindings.get(telegramClientId(agentName.trim()));
    return record ? { ...record } : undefined;
  }

  /**
   * Expose the configured data dir so peer components (e.g. the attachment
   * downloader) can scope their on-disk artefacts under the same root.
   * The accessor is read-only — direct mutation of the YAML store is the
   * store's responsibility.
   */
  getDataDir(): string {
    return this.dataDir();
  }

  async list(): Promise<LocalTelegramBindingRecord[]> {
    await this.load();
    return [...this.bindings.values()]
      .sort((a, b) => a.clientId.localeCompare(b.clientId))
      .map((record) => ({ ...record }));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await readFile(this.filePath, 'utf8').catch(() => undefined);
    if (!raw) return;
    const parsed = yaml.load(raw) as Partial<LocalTelegramChannelFile> | null;
    const bindings = parsed?.bindings;
    if (!bindings || typeof bindings !== 'object') return;
    for (const [clientId, value] of Object.entries(bindings)) {
      const record = normalizeTelegramBinding(clientId, value);
      if (record) this.bindings.set(record.clientId, record);
    }
  }

  private async save(): Promise<void> {
    const payload: LocalTelegramChannelFile = {
      schemaVersion: 1,
      bindings: Object.fromEntries(
        [...this.bindings.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), {
      encoding: 'utf8',
      mode: 0o600,
    });
    // Explicit chmod — on some filesystems (e.g. FAT32 mounts inside CI) the
    // `mode` option is silently ignored.
    await chmod(this.filePath, 0o600);
  }

  private get filePath(): string {
    return join(this.dataDir(), 'telegram-channel.yaml');
  }
}

/**
 * Resolve the real outbound sender + target chat for a given outbound context.
 *
 * Returns `null` when no real SDK-mode binding can be resolved. The exact
 * client treats that as `CHANNEL_CLIENT_UNAVAILABLE`; no caller may turn it
 * into an append-only fake success.
 */
export type TelegramResolveSend = (
  ctx: LocalChannelContext,
) => Promise<{ sender: TelegramSender; chatId: string } | null>;

export class LocalTelegramChannelClient implements LocalMultiChannelClient {
  readonly id: string;
  readonly platform = 'telegram';

  constructor(
    private readonly outboundStore: LocalChannelOutboundStore,
    private readonly resolveSend: TelegramResolveSend,
    clientName: string,
    /** Delegates questionnaire delivery so pending + callback decoding share one adapter. */
    private readonly adapter?: TelegramPlatformAdapter,
  ) {
    this.id = clientName.trim();
  }

  /** Per-chat typing-refresh timers; Telegram clears chat actions after ~5s. */
  private readonly typingTimers = new Map<string, ReturnType<typeof setInterval>>();

  async sendText(input: {
    ctx: LocalChannelContext;
    text: string;
    media?: OutboundMediaRef[];
    sessionId?: string;
    queueItemId?: string;
    error?: string;
  }): Promise<LocalChannelOutboundMessage> {
    return this.sendMessage(input);
  }

  async sendMessage(input: {
    ctx: LocalChannelContext;
    text: string;
    media?: OutboundMediaRef[];
    sessionId?: string;
    queueItemId?: string;
    error?: string;
    questionnaire?: AskQuestionnaireRequest;
  }): Promise<LocalChannelOutboundMessage> {
    const outbound = prepareChannelOutboundMessage(input);
    try {
      await this.deliver(outbound);
      return this.recordOutbound(outbound, 'sent');
    } catch (err) {
      await this.recordOutbound(outbound, 'error', 'CHANNEL_DELIVERY_FAILED');
      throw err;
    }
  }

  private recordOutbound(
    input: {
      ctx: LocalChannelContext;
      text: string;
      media?: OutboundMediaRef[];
      sessionId?: string;
      queueItemId?: string;
      error?: string;
      questionnaire?: AskQuestionnaireRequest;
    },
    status: 'sent' | 'error',
    error = input.error,
  ): Promise<LocalChannelOutboundMessage> {
    return this.outboundStore.append({
      ctx: input.ctx,
      text: input.text,
      status,
      ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
      ...(error ? { error } : {}),
    });
  }

  /** Start best-effort Telegram typing refresh for a running turn. */
  async notifyTurnStart(ctx: LocalChannelContext): Promise<void> {
    try {
      const resolved = await this.resolveSend(ctx);
      if (!resolved) return;
      const { sender, chatId } = resolved;
      await sender.sendChatAction(chatId, 'typing');
      if (!this.typingTimers.has(chatId)) {
        const timer = setInterval(() => {
          void sender.sendChatAction(chatId, 'typing').catch(() => {});
        }, 4000);
        if (typeof timer.unref === 'function') timer.unref();
        this.typingTimers.set(chatId, timer);
      }
    } catch {
      // Best-effort: typing must never surface to the turn.
    }
  }

  /** Stop the typing refresh timer; Telegram auto-expires the last action. */
  async notifyTurnEnd(ctx: LocalChannelContext): Promise<void> {
    try {
      const resolved = await this.resolveSend(ctx);
      const chatId = resolved?.chatId ?? ctx.chatId;
      const timer = this.typingTimers.get(chatId);
      if (timer) {
        clearInterval(timer);
        this.typingTimers.delete(chatId);
      }
    } catch {
      // ignore
    }
  }

  /** Deliver through a real SDK sender; a missing or failed edge rejects. */
  private async deliver(input: {
    ctx: LocalChannelContext;
    text: string;
    media?: OutboundMediaRef[];
    questionnaire?: AskQuestionnaireRequest;
  }): Promise<void> {
    const resolved = await this.resolveSend(input.ctx);
    if (!resolved) throw new LocalChannelClientUnavailableError(input.ctx);

    if (input.questionnaire && this.adapter) {
      const result = await this.adapter.sendMessage({
        ctx: input.ctx,
        text: input.text,
        questionnaire: input.questionnaire,
      });
      if (result.status === 'error') throw new Error(result.error ?? 'Telegram delivery failed');
      return;
    }

    const { sender, chatId } = resolved;

    if (input.questionnaire) {
      await sendTelegramQuestionnaireFallback({ sender, chatId, request: input.questionnaire });
      // Questionnaire keyboard already carries the question text; avoid double-posting.
      return;
    }

    const text = input.text?.trim() ?? '';
    if (text) {
      await sender.sendText(chatId, input.text, undefined, input.ctx.threadId);
    }

    for (const att of input.media ?? []) {
      await sender.sendMedia(chatId, att, input.ctx.threadId);
    }
  }
}

export class LocalTelegramChannelApi {
  private readonly downloaderFactory: NonNullable<
    LocalTelegramChannelApiOptions['downloaderFactory']
  >;

  private readonly senderFactory: NonNullable<LocalTelegramChannelApiOptions['senderFactory']>;

  constructor(
    private readonly store: LocalTelegramChannelStore,
    private readonly runner: LocalChannelRunner,
    private readonly defaultAgentName: string,
    private readonly ownerStore: LocalChannelOwnerStore | undefined,
    private readonly options: LocalTelegramChannelApiOptions = {},
  ) {
    this.downloaderFactory =
      options.downloaderFactory ??
      ((input) =>
        new TelegramAttachmentDownloader({
          botToken: input.botToken,
          dataDir: () => store.getDataDir(),
          scopeDirName: input.scopeDirName,
        }));
    this.senderFactory = options.senderFactory ?? ((botToken) => new TelegramSender(botToken));
  }

  registerClient(record?: LocalTelegramBindingRecord): void {
    if (!isUsableTelegramBinding(record)) return;
    const agentName = record?.agentName ?? this.defaultAgentName;
    const adapter =
      this.options.adapterForAgent?.(agentName) ??
      (agentName === this.defaultAgentName ? this.options.adapter : undefined);
    const client = new LocalTelegramChannelClient(
      this.runner.outboundStore,
      this.buildResolveSend(),
      telegramClientId(agentName),
      adapter,
    );
    this.runner.clients.registerExact(client);
  }

  /**
   * Resolve the per-agent adapter, creating and registering it in the shared
   * adapter registry as a side effect when the factory is wired. Bind uses this
   * so a never-before-bound agent can register on first bind instead of
   * dead-ending in a 503 that only a prior successful bind could have cleared.
   */
  ensureAdapterForAgent(agentName: string): TelegramPlatformAdapter | undefined {
    return this.options.adapterForAgent?.(agentName) ?? this.options.adapter;
  }

  /**
   * Build the resolver the outbound client uses to obtain a real
   * {@link TelegramSender} for a given context.
   *
   * The agent name is recovered from `ctx.clientName` (telegram inbound sets
   * it to `telegram:{agentName}` — see {@link parseLocalTelegramUpdate}); we
   * fall back to the channel's default agent when the ctx carries no usable
   * client name. Real sending requires an enabled, connected SDK binding with
   * a non-empty token; anything else resolves to `null`, which the exact
   * client turns into `CHANNEL_CLIENT_UNAVAILABLE`.
   */
  private buildResolveSend(): TelegramResolveSend {
    return async (ctx: LocalChannelContext) => {
      const agentName = agentNameFromContext(ctx, this.defaultAgentName);
      const record = await this.store.get(agentName);
      if (!isUsableTelegramBinding(record)) return null;
      if (!ctx.chatId) return null;
      return { sender: this.senderFactory(record.botToken), chatId: ctx.chatId };
    };
  }

  async statusClients(): Promise<Record<string, unknown>> {
    const clients: Record<string, unknown> = {};
    for (const record of await this.store.list()) {
      clients[record.clientId] = serializeTelegramBinding(record);
    }
    return clients;
  }

  async configCheck(agentName?: string): Promise<Record<string, unknown>> {
    const record = await this.store.get(agentName ?? this.defaultAgentName);
    return {
      configured: Boolean(record?.botToken),
      source: record ? 'local-runtime' : null,
      hasCredentials: Boolean(record?.botToken),
      platform: 'telegram',
      clientId: record?.clientId ?? telegramClientId(agentName ?? this.defaultAgentName),
      localRuntime: true,
      runnerEnabled: true,
    };
  }

  async bind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const requestedMode = readFirstString(body, ['mode'])?.toLowerCase();
    if (requestedMode === 'mock') {
      return json(
        {
          ok: false,
          error: 'mock channel mode is not supported',
          code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
          platform: 'telegram',
          localRuntime: true,
        },
        { status: 400 },
      );
    }
    if (requestedMode && requestedMode !== 'sdk') {
      return json(
        {
          ok: false,
          error: 'unsupported channel mode',
          code: 'VALIDATION_ERROR',
          platform: 'telegram',
          localRuntime: true,
        },
        { status: 400 },
      );
    }
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
    const botToken = readFirstString(body, ['botToken', 'token']);
    if (!botToken) {
      return json(
        { ok: false, error: 'botToken is required', code: 'VALIDATION_ERROR', localRuntime: true },
        { status: 400 },
      );
    }

    // Validate the token by calling Telegram's getMe endpoint.
    let verifiedBotName: string | undefined;
    const verifyFetch = this.options.tokenVerifyFetcher ?? fetch;
    try {
      const getMeResponse = await verifyFetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const getMeData = (await getMeResponse.json()) as {
        ok: boolean;
        result?: { first_name?: string; username?: string };
        description?: string;
      };
      if (!getMeData.ok) {
        return json(
          {
            ok: false,
            error: `Invalid bot token: ${getMeData.description ?? 'getMe returned ok=false'}`,
            code: 'INVALID_BOT_TOKEN',
            localRuntime: true,
          },
          { status: 400 },
        );
      }
      const result = getMeData.result;
      // Store just the `@username` handle — that is the only token Telegram
      // ever puts in @mentions / `/command@bot` suffixes, so it is what the
      // mention + command matchers compare against. (Concatenating first_name
      // produced a two-token value that broke matching and displayed a
      // duplicated name.)
      verifiedBotName = result?.username
        ? `@${result.username}`
        : (result?.first_name ?? undefined);
    } catch (err) {
      // No silent mock fallback — if we cannot reach Telegram to validate the
      // token, refuse the bind. A "bind ok but mock-only" outcome was the root
      // cause of users perceiving a successful bind while messages never
      // reached Telegram. Surface the error to the UI instead.
      const msg = err instanceof Error ? err.message : String(err);
      return json(
        {
          ok: false,
          error: `Failed to verify bot token via Telegram getMe: ${msg}`,
          code: 'TELEGRAM_VERIFY_UNREACHABLE',
          localRuntime: true,
        },
        { status: 502 },
      );
    }

    const record = await this.store.bind({
      agentName,
      botToken,
      botName: verifiedBotName ?? readFirstString(body, ['botName', 'username', 'botUsername']),
      mode: 'sdk',
    });
    // Plan §5.2: a staged / non-winner record registers no outbound client.
    if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(agentName))) {
      logger.info(
        { agentName, platform: 'telegram', clientId: record.clientId },
        'Telegram bind transport start delegated to family reconciler',
      );
      return json({ ok: true, ...serializeTelegramBinding(record) });
    }
    this.registerClient(record);
    return json({ ok: true, ...serializeTelegramBinding(record) });
  }

  async unbind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
    // Stop the inbound long-poll BEFORE deleting the store record so an
    // in-flight `getUpdates` result cannot dispatch after the binding is
    // gone. The per-agent adapter owns the poll wire; `shutdown()` is
    // idempotent + null-safe. Scoped strictly to this agentName so a sibling
    // agent's poller is never touched. The dedicated `telegram/unbind`
    // adapter route already stops the poller via `adapter.unbind`; this
    // covers the legacy / `/disconnect` path that goes through this API.
    if (this.options.onUnbind) await this.options.onUnbind(agentName);
    else this.options.adapterForAgent?.(agentName)?.shutdown();
    const unbound = await this.store.unbind(agentName);
    // Drop the recorded owner so the next DM after re-bind can claim ownership.
    // Best-effort: a missing owner record is not an error.
    //
    // Telegram is daemon-local today (it does NOT go through the imGateway), so
    // its inbound owner key already IS `telegramClientId(agentName)` =
    // `telegram:<agent>`. We still clear the imGateway key `${agentName}:telegram`
    // for symmetry with Feishu/WeChat (belt-and-suspenders, deduped to a single
    // clear when the two keys differ) — harmless if no such record exists.
    if (unbound && this.ownerStore) {
      await clearOwnerAllConventions(
        this.ownerStore,
        agentName,
        'telegram',
        telegramClientId(agentName),
      );
    }
    return json({
      ok: true,
      unbound,
      platform: 'telegram',
      clientId: telegramClientId(agentName),
      localRuntime: true,
    });
  }

  async handleUpdate(
    request: Request,
    dispatch: boolean,
    requireBinding = false,
  ): Promise<Response> {
    const body = await readJsonBody(request);
    if (requireBinding) {
      const agentName =
        readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
      const record = await this.store.get(agentName);
      if (!record?.enabled || !record.botToken) {
        return json(
          {
            ok: false,
            error: 'Telegram binding is not configured',
            code: 'TELEGRAM_BINDING_REQUIRED',
            platform: 'telegram',
            clientId: telegramClientId(agentName),
            localRuntime: true,
          },
          { status: 401 },
        );
      }
    }
    const envelope = parseLocalTelegramUpdate(body, this.defaultAgentName);
    if ('error' in envelope) return envelope.error;
    let attachments: LocalMessageAttachment[] | undefined;
    if (dispatch && envelope.attachmentRefs.length > 0) {
      attachments = await this.downloadAttachments(body, envelope);
    }
    if (dispatch) {
      return json(
        await this.runner.dispatchInbound({
          ctx: envelope.ctx,
          text: envelope.text,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
          ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        }),
      );
    }
    return json({
      ok: true,
      envelope,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      localRuntime: true,
    });
  }

  /**
   * Download every attachment referenced by `envelope.attachmentRefs` using
   * the bound bot token. Failures degrade gracefully — a single broken
   * download does NOT block the parent message; the resulting attachment is
   * tagged with `error: 'download_failed: …'` and the rest of the batch is
   * delivered unchanged.
   *
   * The downloader is created lazily per request so each `handleUpdate` call
   * sees a fresh `crypto.randomBytes`-backed id generator and the bot token
   * is read from the persisted binding at call time. Tests inject their own
   * downloader via {@link LocalTelegramChannelApiOptions.downloaderFactory}
   * to substitute a stubbed `fetcher`.
   */
  private async downloadAttachments(
    body: Record<string, unknown>,
    envelope: LocalTelegramEnvelope,
  ): Promise<LocalMessageAttachment[]> {
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent']) ?? this.defaultAgentName;
    const record = await this.store.get(agentName);
    if (!record?.botToken) {
      // No token — degrade to text-only. The earlier `requireBinding` gate
      // already rejected requests without a binding when one was required,
      // so this branch only fires for an ungated local dispatch path.
      return [];
    }
    const downloader = this.downloaderFactory({
      botToken: record.botToken,
      scopeDirName: envelope.ctx.clientName,
    });
    const items = extractTelegramAttachmentRefs(findTelegramMessage(body));
    if (items.length === 0) return [];
    return downloader.downloadAll(items);
  }
}

export interface LocalTelegramChannelApiOptions {
  /**
   * Factory used to construct the per-request `TelegramAttachmentDownloader`.
   * Defaults to the production factory wired with the channel store's
   * `dataDir`. Tests substitute a stub that bypasses real network I/O.
   */
  downloaderFactory?: (input: {
    botToken: string;
    scopeDirName: string;
  }) => TelegramAttachmentDownloader;
  /**
   * Factory used to construct the outbound {@link TelegramSender} for an
   * SDK-mode binding. Defaults to the production factory wired with the
   * resolved bot token. Tests substitute a stub sender to assert text + media
   * delivery without real Bot API I/O. Mirrors the `downloaderFactory`
   * injection pattern.
   */
  senderFactory?: (botToken: string) => TelegramSender;
  /**
   * Fetch implementation used to verify a bot token via Telegram's `getMe`
   * endpoint during {@link LocalTelegramChannelApi.bind}. Defaults to the global
   * `fetch`. Tests inject a stub so binding never performs real network I/O —
   * without this, `bind` reaches `api.telegram.org` and its result depends on
   * whether the test host has internet (a fake token returns 401 online but the
   * fetch throws offline), making the bind outcome environment-dependent.
   */
  tokenVerifyFetcher?: typeof fetch;
  /**
   * Unified-channel adapter shared with the infra adapter registry. When set,
   * {@link LocalTelegramChannelApi.registerClient} hands it to the outbound
   * client so questionnaire delivery records pending on the same adapter that
   * decodes the callback_query reply. Must be the SAME instance registered in
   * the adapter registry, or inbound taps won't match outbound pendings.
   */
  adapter?: TelegramPlatformAdapter;
  /**
   * Resolve the adapter matching a concrete agent. New dev wiring can have one
   * Telegram adapter per bound agent; legacy outbound clients must delegate to
   * the same per-agent adapter instance registered for inbound callbacks.
   */
  adapterForAgent?: (agentName: string) => TelegramPlatformAdapter;
  /**
   * Exact-edge cleanup supplied by the host. It stops the per-agent adapter
   * and removes its runner + registry entries before the credential row goes
   * away, so an unbound client cannot report a fake local delivery.
   */
  onUnbind?: (agentName: string) => void | Promise<void>;
}

export function parseLocalTelegramUpdate(
  body: Record<string, unknown>,
  defaultAgentName = 'mavis',
): LocalTelegramEnvelope | { error: Response } {
  const rawUpdate = isRecord(body.update) ? body.update : body;
  const message = firstRecord(rawUpdate, ['message', 'edited_message', 'channel_post']);
  if (!message) {
    return {
      error: json(
        { error: 'Telegram update message is required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  const chat = isRecord(message.chat) ? message.chat : {};
  const from = isRecord(message.from) ? message.from : chat;
  const text = readFirstString(message, ['text', 'caption']) ?? '';
  const chatId = stringish(chat.id);
  const senderId = stringish(from.id) ?? chatId;
  if (!chatId || !senderId) {
    return {
      error: json(
        { error: 'Telegram chat.id and sender id are required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? defaultAgentName;
  const botName = normalizeTelegramBotName(
    readFirstString(body, ['botName', 'username', 'botUsername']),
  );
  const clientName =
    readFirstString(body, ['clientName', 'clientId', 'client_id']) ?? telegramClientId(agentName);
  const threadId = stringish(message.message_thread_id);
  const ctx: LocalChannelContext = {
    platform: 'telegram',
    chatType: readFirstString(chat, ['type']) ?? 'private',
    chatId,
    senderId,
    clientName,
    ...(threadId ? { threadId } : {}),
    ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
    hasMention:
      body.hasMention === true ||
      body.mentioned === true ||
      isPrivateChat(chat) ||
      telegramTextMentionsBot(text, botName) ||
      telegramEntitiesMentionBot(message.entities, text, botName),
  };
  return {
    ctx,
    text: stripTelegramBotMention(text, botName).trim() || text,
    attachmentRefs: extractTelegramAttachmentRefs(message).map((item) => item.ref),
    ...(stringish(rawUpdate.update_id) ? { eventId: stringish(rawUpdate.update_id) } : {}),
  };
}

/**
 * Telegram's Bot API puts each media-bearing message variant on a dedicated
 * top-level key (`photo`, `document`, `voice`, `audio`, `video`, `sticker`).
 * This helper normalises all six into the platform-neutral
 * `ChannelInboundAttachmentRef` shape and pairs each ref with its kind so the
 * downloader can pick the right MIME fallback.
 *
 * Order matches Telegram's typical user behaviour: photos are usually the
 * first thing the user attaches, documents last. The order we return here
 * is the order the runner will see them, which is preserved through to the
 * agent prompt — keep it stable.
 *
 * Returns an empty array for text-only messages; never throws.
 */
export function extractTelegramAttachmentRefs(
  message: Record<string, unknown>,
): Array<{ kind: TelegramAttachmentKind; ref: ChannelInboundAttachmentRef }> {
  const items: Array<{ kind: TelegramAttachmentKind; ref: ChannelInboundAttachmentRef }> = [];

  const photo = pickLargestPhoto(message.photo as Array<Record<string, unknown>> | undefined);
  if (photo && typeof photo.file_id === 'string') {
    items.push({
      kind: 'photo',
      ref: {
        type: 'image',
        key: photo.file_id,
        ...(typeof photo.file_unique_id === 'string' ? { name: photo.file_unique_id } : {}),
        ...(readNumber(photo.file_size) !== undefined ? { size: readNumber(photo.file_size) } : {}),
      },
    });
  }

  const sticker = isRecord(message.sticker) ? message.sticker : undefined;
  if (sticker) {
    const fileId = readFirstString(sticker, ['file_id']);
    if (fileId) {
      items.push({
        kind: 'sticker',
        ref: {
          type: 'image',
          key: fileId,
          ...(readFirstString(sticker, ['emoji'])
            ? { name: readFirstString(sticker, ['emoji']) }
            : {}),
          ...(readNumber(sticker.file_size) !== undefined
            ? { size: readNumber(sticker.file_size) }
            : {}),
        },
      });
    }
  }

  const video = isRecord(message.video) ? message.video : undefined;
  if (video) {
    const fileId = readFirstString(video, ['file_id']);
    if (fileId) {
      items.push({
        kind: 'video',
        ref: {
          type: 'video',
          key: fileId,
          ...(readFirstString(video, ['file_name'])
            ? { name: readFirstString(video, ['file_name']) }
            : {}),
          ...(readFirstString(video, ['mime_type'])
            ? { mimeType: readFirstString(video, ['mime_type']) }
            : {}),
          ...(readNumber(video.file_size) !== undefined
            ? { size: readNumber(video.file_size) }
            : {}),
        },
      });
    }
  }

  const voice = isRecord(message.voice) ? message.voice : undefined;
  if (voice) {
    const fileId = readFirstString(voice, ['file_id']);
    if (fileId) {
      items.push({
        kind: 'voice',
        ref: {
          type: 'audio',
          key: fileId,
          ...(readFirstString(voice, ['mime_type'])
            ? { mimeType: readFirstString(voice, ['mime_type']) }
            : {}),
          ...(readNumber(voice.file_size) !== undefined
            ? { size: readNumber(voice.file_size) }
            : {}),
        },
      });
    }
  }

  const audio = isRecord(message.audio) ? message.audio : undefined;
  if (audio) {
    const fileId = readFirstString(audio, ['file_id']);
    if (fileId) {
      items.push({
        kind: 'audio',
        ref: {
          type: 'audio',
          key: fileId,
          ...(readFirstString(audio, ['file_name'])
            ? { name: readFirstString(audio, ['file_name']) }
            : readFirstString(audio, ['title'])
              ? { name: readFirstString(audio, ['title']) }
              : {}),
          ...(readFirstString(audio, ['mime_type'])
            ? { mimeType: readFirstString(audio, ['mime_type']) }
            : {}),
          ...(readNumber(audio.file_size) !== undefined
            ? { size: readNumber(audio.file_size) }
            : {}),
        },
      });
    }
  }

  const document = isRecord(message.document) ? message.document : undefined;
  if (document) {
    const fileId = readFirstString(document, ['file_id']);
    if (fileId) {
      items.push({
        kind: 'document',
        ref: {
          type: 'file',
          key: fileId,
          ...(readFirstString(document, ['file_name'])
            ? { name: readFirstString(document, ['file_name']) }
            : {}),
          ...(readFirstString(document, ['mime_type'])
            ? { mimeType: readFirstString(document, ['mime_type']) }
            : {}),
          ...(readNumber(document.file_size) !== undefined
            ? { size: readNumber(document.file_size) }
            : {}),
        },
      });
    }
  }

  return items;
}

export function telegramClientId(agentName: string): string {
  return `telegram:${agentName.trim() || 'mavis'}`;
}

/**
 * Recover the agent name from an outbound context so the resolver can look up
 * the matching binding. Telegram inbound sets `ctx.clientName` to
 * `telegram:{agentName}` (see {@link parseLocalTelegramUpdate}); we strip the
 * `telegram:` prefix to get the agent name back. Falls back to the channel's
 * default agent when the ctx carries no usable client name.
 */
function agentNameFromContext(ctx: LocalChannelContext, defaultAgentName: string): string {
  const clientName = ctx.clientName?.trim();
  if (clientName) {
    const withoutPrefix = clientName.startsWith('telegram:')
      ? clientName.slice('telegram:'.length)
      : clientName;
    if (withoutPrefix.trim()) return withoutPrefix.trim();
  }
  return defaultAgentName;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function serializeTelegramBinding(record: LocalTelegramBindingRecord): Record<string, unknown> {
  return {
    ok: true,
    platform: 'telegram',
    clientId: record.clientId,
    agentName: record.agentName,
    connected: record.connected,
    enabled: record.enabled,
    mode: record.mode,
    tokenMasked: maskToken(record.botToken),
    hasCredentials: Boolean(record.botToken),
    localRuntime: true,
    ...(record.botName ? { botName: record.botName } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeTelegramBinding(
  fallbackClientId: string,
  value: unknown,
): LocalTelegramBindingRecord | undefined {
  if (!isRecord(value)) return undefined;
  const agentName = readFirstString(value, ['agentName', 'agentId', 'agent']);
  const botToken = readFirstString(value, ['botToken', 'token']);
  if (!agentName || !botToken) return undefined;
  return {
    clientId: readFirstString(value, ['clientId']) ?? fallbackClientId,
    agentName,
    botToken,
    ...(readFirstString(value, ['botName'])
      ? { botName: readFirstString(value, ['botName']) }
      : {}),
    ...normalizePersistedTelegramState(value),
    createdAt: readNumber(value.createdAt) ?? Date.now(),
    updatedAt: readNumber(value.updatedAt) ?? Date.now(),
  };
}

function normalizePersistedTelegramState(
  value: Record<string, unknown>,
): Pick<LocalTelegramBindingRecord, 'connected' | 'enabled' | 'mode'> {
  const mode = value.mode === 'sdk' ? 'sdk' : 'mock';
  if (mode === 'mock') return { mode, connected: false, enabled: false };
  return { mode, connected: value.connected !== false, enabled: value.enabled !== false };
}

function firstRecord(
  raw: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    if (isRecord(raw[key])) return raw[key];
  }
  return undefined;
}

/**
 * Locate the inbound Telegram message inside a webhook body. Mirrors the
 * `parseLocalTelegramUpdate` traversal so the downloader sees the same
 * payload structure that the parser used to populate `attachmentRefs`.
 * Returns an empty record when the body does not match the expected shape —
 * callers should treat that as "no attachments".
 */
function findTelegramMessage(body: Record<string, unknown>): Record<string, unknown> {
  const rawUpdate = isRecord(body.update) ? body.update : body;
  return firstRecord(rawUpdate, ['message', 'edited_message', 'channel_post']) ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringish(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function maskToken(token: string): string {
  if (token.length <= 6) return '***';
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

function isPrivateChat(chat: Record<string, unknown>): boolean {
  return readFirstString(chat, ['type']) === 'private';
}

function telegramTextMentionsBot(text: string, botName?: string): boolean {
  if (!botName) return false;
  return text.toLowerCase().includes(`@${botName.replace(/^@/u, '').toLowerCase()}`);
}

function telegramEntitiesMentionBot(entities: unknown, text: string, botName?: string): boolean {
  if (!Array.isArray(entities)) return false;
  return entities.some((entity) => {
    if (!isRecord(entity)) return false;
    const type = readFirstString(entity, ['type']);
    const offset = readNumber(entity.offset);
    const length = readNumber(entity.length);
    if (offset === undefined || length === undefined) {
      return type === 'bot_command' && !botName;
    }
    const entityText = text.slice(offset, offset + length).toLowerCase();
    if (type === 'bot_command') return botCommandTargetsBot(entityText, botName);
    if (type !== 'mention') return false;
    const mention = entityText;
    return !botName || mention === `@${botName.replace(/^@/u, '').toLowerCase()}`;
  });
}

function botCommandTargetsBot(command: string, botName?: string): boolean {
  const atIndex = command.indexOf('@');
  if (atIndex < 0) return true;
  if (!botName) return false;
  return command.slice(atIndex + 1).toLowerCase() === botName.replace(/^@/u, '').toLowerCase();
}

function stripTelegramBotMention(text: string, botName?: string): string {
  if (!botName) return text;
  return text
    .replace(new RegExp(`@${escapeRegExp(botName.replace(/^@/u, ''))}\\b`, 'giu'), '')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Reduce a stored Telegram bot name to the single `@username` token used for
 * mention/command matching. Older binds stored `${first_name} @${username}`
 * (two whitespace-separated tokens), which broke `stripTelegramBotMention`
 * and `botCommandTargetsBot` — they treat the whole string as one handle. We
 * now store just `@username` on bind, but existing bindings carry the legacy
 * value, so normalise defensively on read: pick the `@`-prefixed token when
 * present, otherwise fall back to the raw value.
 */
export function normalizeTelegramBotName(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const handleToken = trimmed.split(/\s+/u).find((token) => token.startsWith('@'));
  return handleToken ?? trimmed;
}
