import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

import type { OutboundMediaRef } from '@mavis/shared';

import {
  type DeadLetterRefKind,
  LocalDeadLetterStore,
  makeDeadLetterCallback,
  withRetry,
} from './attachment-retry.js';
import type { LocalChannelContext } from './infra.js';
import { prepareChannelOutboundMessage } from './outbound-message.js';
import { json, readFirstString, readJsonBody } from '../api/http-helpers.js';
import { LocalAgentContractError } from '../agent/contract.js';
import {
  PRIMARY_AGENT_CHANNEL_CONFLICT,
  PrimaryAgentChannelConflictError,
} from '../api/host-channel-family-gate.js';
import type {
  LocalChannelOutboundStore,
  LocalChannelOutboundMessage,
  LocalChannelRunner,
  LocalMultiChannelClient,
} from './runner.js';
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from './envelope.js';
import type { LocalChannelOwnerStore } from './owner-store.js';
import { clearOwnerAllConventions } from './owner-store.js';
import type {
  ChannelFamilyMutationHook,
  ChannelFamilyMutationKind,
} from './channel-family-mutation.js';
import type { LocalMessageAttachment } from '../messages/input.js';
import {
  applyMonitorHealthOverlay,
  normalizeWeChatBinding,
  serializeWeChatBinding,
} from './wechat-binding-serde.js';
import { imLogger as logger } from '../common/im-logger.js';

export interface LocalWeChatBindingRecord {
  clientId: string;
  agentName: string;
  botToken: string;
  ilinkBotId?: string;
  baseUrl?: string;
  webhookToken?: string;
  botName?: string;
  bindSessionId?: string;
  /**
   * iLink QR token returned by `get_bot_qrcode`. Persisted alongside the
   * binding so a subsequent `bind/status` poll can call
   * `get_qrcode_status?qrcode=<token>` without re-issuing the QR. Distinct
   * from `webhookToken` (which signs inbound webhook events).
   *
   * MR-D1: introduced to support the real iLink onboard flow in
   * `wechat-onboard.ts`. The legacy direct-bind path never reads or writes
   * this field.
   */
  qrcodeToken?: string;
  qrcodeUrl?: string;
  /**
   * Persisted iLink long-poll cursor (`get_updates_buf`). The monitor wire
   * writes this on every `disconnected` event so a desktop restart can
   * resume the long-poll after the last delivered update, instead of
   * starting from "now" (silent message loss while the desktop was
   * closed) or from "epoch" (slow replay of the entire historical
   * backlog).
   */
  getUpdatesBuf?: string;
  connected: boolean;
  enabled: boolean;
  mode: 'mock' | 'polling';
  createdAt: number;
  updatedAt: number;
}

interface LocalWeChatChannelFile {
  schemaVersion: number;
  bindings: Record<string, LocalWeChatBindingRecord>;
}

export type LocalWeChatEnvelope = ChannelInboundEnvelope;

export class LocalWeChatChannelStore {
  private loaded = false;
  private readonly bindings = new Map<string, LocalWeChatBindingRecord>();
  private familyHook: ChannelFamilyMutationHook | undefined;

  constructor(
    private readonly dataDir: () => string,
    private readonly nowMs: () => number,
  ) {}

  /** Resolve the active dataDir; exposed so adapters can co-locate scratch files. */
  getDataDir(): string {
    return this.dataDir();
  }

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

  /** Copy one binding's whole credential group onto another agentName. */
  async cloneBindingForAgent(input: {
    fromAgentName: string;
    toAgentName: string;
    enabled: boolean;
  }): Promise<LocalWeChatBindingRecord | undefined> {
    await this.load();
    const source = this.bindings.get(wechatClientId(input.fromAgentName.trim()));
    if (!source) return undefined;
    const toAgentName = input.toAgentName.trim();
    const clientId = wechatClientId(toAgentName);
    const existing = this.bindings.get(clientId);
    const record: LocalWeChatBindingRecord = {
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
  ): Promise<LocalWeChatBindingRecord | undefined> {
    await this.load();
    const clientId = wechatClientId(agentName.trim());
    const existing = this.bindings.get(clientId);
    if (!existing) return undefined;
    if (existing.enabled === enabled) return { ...existing };
    const record: LocalWeChatBindingRecord = { ...existing, enabled, updatedAt: this.nowMs() };
    this.bindings.set(clientId, record);
    await this.save();
    return { ...record };
  }

  async bind(input: {
    agentName: string;
    botToken: string;
    ilinkBotId?: string;
    baseUrl?: string;
    webhookToken?: string;
    botName?: string;
    bindSessionId?: string;
    qrcodeToken?: string;
    qrcodeUrl?: string;
    mode?: 'polling';
    connected?: boolean;
    /** Internal state-only import: persist without invoking the live family hook. */
    suppressFamilyMutation?: boolean;
  }): Promise<LocalWeChatBindingRecord> {
    await this.load();
    const agentName = input.agentName.trim();
    const clientId = wechatClientId(agentName);
    const existing = this.bindings.get(clientId);
    const now = this.nowMs();
    const botToken = input.botToken.trim();
    const pending = isPendingWeChatBindingToken(botToken);
    // Staged disabled for the primary family — see `feishu.ts` bind(). A QR
    // pending record is also always disabled, including for a custom Agent:
    // it proves neither a credential nor a transport and must never become a
    // family winner before the confirmation write below.
    const primaryFamily =
      input.suppressFamilyMutation !== true && (await this.isPrimaryFamilyAgent(agentName));
    const record: LocalWeChatBindingRecord = {
      clientId,
      agentName,
      botToken,
      ...(input.ilinkBotId?.trim() ? { ilinkBotId: input.ilinkBotId.trim() } : {}),
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      ...(input.webhookToken?.trim() ? { webhookToken: input.webhookToken.trim() } : {}),
      ...(input.botName?.trim() ? { botName: input.botName.trim() } : {}),
      ...(input.bindSessionId?.trim() ? { bindSessionId: input.bindSessionId.trim() } : {}),
      ...(input.qrcodeToken?.trim() ? { qrcodeToken: input.qrcodeToken.trim() } : {}),
      ...(input.qrcodeUrl?.trim() ? { qrcodeUrl: input.qrcodeUrl.trim() } : {}),
      connected: input.connected ?? false,
      enabled: !pending && !primaryFamily,
      mode: input.mode ?? 'polling',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.bindings.set(clientId, record);
    await this.save();
    // Pending QR creation still resolved the trusted family above (so a manual
    // reserved primary name fails closed), but does not reconcile/activate a
    // placeholder. The confirmed write is the first mutation that may start a
    // real winner.
    if (primaryFamily && !pending) {
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
    const existing = this.bindings.get(wechatClientId(trimmed));
    const deleted = this.bindings.delete(wechatClientId(trimmed));
    if (deleted) await this.save();
    if (
      existing &&
      deleted &&
      options?.suppressFamilyMutation !== true &&
      (await this.isPrimaryFamilyAgent(trimmed, 'unbind')) === true
    ) {
      const identity = existing.ilinkBotId?.trim() || existing.botToken.trim();
      await this.familyHook?.afterMutation({
        agentName: trimmed,
        kind: 'unbind',
        unbound: { enabled: existing.enabled, ...(identity ? { identity } : {}) },
      });
    }
    return deleted;
  }

  /**
   * Persist the iLink long-poll cursor for a bound agent. Returns true on
   * write, false when the binding does not exist (rare: the monitor wire
   * survived an unbind by a few ms). Treats empty/identical cursors as
   * no-ops to avoid spamming the YAML file on every poll tick.
   */
  async setGetUpdatesBuf(agentName: string, cursor: string): Promise<boolean> {
    await this.load();
    const clientId = wechatClientId(agentName.trim());
    const existing = this.bindings.get(clientId);
    if (!existing) return false;
    const next = cursor.trim();
    if ((existing.getUpdatesBuf ?? '') === next) return false;
    const updated: LocalWeChatBindingRecord = {
      ...existing,
      ...(next ? { getUpdatesBuf: next } : {}),
      updatedAt: this.nowMs(),
    };
    if (!next) delete (updated as Partial<LocalWeChatBindingRecord>).getUpdatesBuf;
    this.bindings.set(clientId, updated);
    await this.save();
    return true;
  }

  async get(agentName: string): Promise<LocalWeChatBindingRecord | undefined> {
    await this.load();
    const record = this.bindings.get(wechatClientId(agentName.trim()));
    return record ? { ...record } : undefined;
  }

  async getByBindSessionId(sessionId: string): Promise<LocalWeChatBindingRecord | undefined> {
    await this.load();
    const record = [...this.bindings.values()].find(
      (binding) => binding.bindSessionId === sessionId,
    );
    return record ? { ...record } : undefined;
  }

  async list(): Promise<LocalWeChatBindingRecord[]> {
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
    const parsed = yaml.load(raw) as Partial<LocalWeChatChannelFile> | null;
    const bindings = parsed?.bindings;
    if (!bindings || typeof bindings !== 'object') return;
    for (const [clientId, value] of Object.entries(bindings)) {
      const record = normalizeWeChatBinding(clientId, value);
      if (record) this.bindings.set(record.clientId, record);
    }
  }

  private async save(): Promise<void> {
    const payload: LocalWeChatChannelFile = {
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
    await chmod(this.filePath, 0o600);
  }

  private get filePath(): string {
    return join(this.dataDir(), 'wechat-channel.yaml');
  }
}

export class LocalWeChatChannelClient implements LocalMultiChannelClient {
  readonly id: string;
  readonly platform = 'wechat';

  /**
   * ALL delivery goes through the exact bound iLink adapter. The adapter writes
   * the outbound audit store after the platform send result; there is no
   * unbound append-only fallback.
   */
  constructor(
    private readonly outboundStore: LocalChannelOutboundStore,
    private readonly adapter: import('./adapters/wechat/wechat-adapter.js').LocalWeChatChannelAdapter,
  ) {
    this.id = adapter.clientName;
  }

  sendText(input: {
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
    questionnaire?: import('@mavis/shared/questionnaire').AskQuestionnaireRequest;
  }): Promise<LocalChannelOutboundMessage> {
    const outbound = prepareChannelOutboundMessage(input);
    // Questionnaire branch — render via the adapter's WeChat questionnaire
    // helper (numbered-text fallback; WeChat has no native interactive
    // form). When the adapter is wired, prefer its renderQuestionnaire so
    // the pending submit-resolver bookkeeping (per-chat) stays correct.
    if (outbound.questionnaire) {
      const { toRenderableQuestionnaire } = await import('./questionnaire-bridge.js');
      const renderable = toRenderableQuestionnaire(outbound.questionnaire);
      await this.adapter.renderQuestionnaire({ ctx: outbound.ctx, renderable });
      return this.requireRecordedOutbound({ ctx: outbound.ctx });
    }

    await this.adapter.sendMessage({
      ctx: outbound.ctx,
      text: outbound.text,
      ...(outbound.media ? { media: outbound.media } : {}),
      ...(outbound.sessionId ? { sessionId: outbound.sessionId } : {}),
      ...(outbound.queueItemId ? { queueItemId: outbound.queueItemId } : {}),
      ...(outbound.error ? { error: outbound.error } : {}),
    });
    return this.requireRecordedOutbound(outbound);
  }

  private async requireRecordedOutbound(input: {
    ctx: LocalChannelContext;
    queueItemId?: string;
  }): Promise<LocalChannelOutboundMessage> {
    const list = await this.outboundStore.list();
    const matched = [...list]
      .reverse()
      .find(
        (message) =>
          message.platform === 'wechat' &&
          message.clientName === this.id &&
          message.chatId === input.ctx.chatId &&
          (input.queueItemId ? message.queueItemId === input.queueItemId : true),
      );
    if (matched) return matched;
    throw new Error(
      'CHANNEL_OUTBOUND_RECORD_MISSING: wechat adapter completed without audit record',
    );
  }
}

export class LocalWeChatChannelApi {
  constructor(
    private readonly store: LocalWeChatChannelStore,
    private readonly runner: LocalChannelRunner,
    private readonly defaultAgentName: string,
    private readonly makeId: (prefix: string) => string,
    /**
     * Optional channel owner store. When provided, `unbind` clears the §4.6
     * AccessControl owner record so a re-bind (possibly by a different person)
     * can re-claim ownership. Previously this api had no `ownerStore` handle at
     * all, so WeChat unbind never cleared the owner stored under the imGateway
     * key `mavis:wechat` (im-runtime-bridge.ts:238) — a re-binding user was then
     * denied with `access-control:owner_only`.
     */
    private readonly ownerStore?: LocalChannelOwnerStore,
    /**
     * Optional fetch override for the iLink onboard flow (`startBindReal` /
     * `pollBindStatusReal`). When omitted we fall back to `globalThis.fetch`
     * — production wires nothing, tests inject a stub so the QR / status
     * long-poll behaviour can be driven deterministically without real
     * network I/O.
     */
    private readonly onboardFetch?: import('./adapters/wechat/wechat-onboard.js').WeChatFetch,
    /**
     * Awaited after `bindStatus` finalises a `confirmed` onboarding flow.
     * Hosts wire this to
     * `LocalWeChatChannelAdapter.startMonitor()` so the iLink long-poll
     * fires the moment the user finishes scanning — without this, the
     * monitor only starts on next desktop boot (via `restoreInboundLoops`)
     * which means the user has to restart the app before their bot
     * actually receives any messages.
     */
    private readonly onBindFinalised?: (agentName: string) => void | Promise<void>,
    /**
     * Optional live inbound-monitor health probe. Hosts wire this to
     * `LocalWeChatChannelAdapter.monitorHealth()` so {@link statusClients}
     * can downgrade a disk-`connected` binding whose iLink long-poll is
     * actually dead (session expired / stopped) or reconnecting — otherwise
     * the UI shows "bound" while the bot silently receives nothing.
     */
    private readonly monitorHealthProvider?: (
      agentName: string,
    ) => { running: boolean; status: string | null } | undefined,
    /**
     * Optional per-agent transport teardown hook. Wired by the host to
     * `getOrCreateWeChatAdapter(agentName).shutdown()`. Called at the TOP of
     * `unbind` — BEFORE `store.unbind` — so the iLink monitor long-poll is
     * stopped while the record still exists (closing the "record deleted but
     * in-flight inbound still lands" window). Idempotent + null-safe: a
     * missing / already-stopped monitor is a no-op. Scoped strictly to the
     * agentName being unbound so a sibling agent's monitor is never touched.
     */
    private readonly onUnbind?: (agentName: string) => void | Promise<void>,
  ) {}

  registerClient(
    adapter: import('./adapters/wechat/wechat-adapter.js').LocalWeChatChannelAdapter,
  ): void {
    this.runner.clients.registerExact(
      new LocalWeChatChannelClient(this.runner.outboundStore, adapter),
    );
  }

  async statusClients(): Promise<Record<string, unknown>> {
    const clients: Record<string, unknown> = {};
    for (const record of await this.store.list()) {
      const serialized = serializeWeChatBinding(record);
      applyMonitorHealthOverlay(serialized, record, this.monitorHealthProvider?.(record.agentName));
      clients[record.clientId] = serialized;
    }
    return clients;
  }

  async configCheck(agentName?: string): Promise<Record<string, unknown>> {
    const record = await this.store.get(agentName ?? this.defaultAgentName);
    return {
      configured: isUsableWeChatBinding(record),
      source: record ? 'local-runtime' : null,
      hasCredentials: Boolean(record?.botToken && !isPendingWeChatBindingToken(record.botToken)),
      platform: 'wechat',
      clientId: record?.clientId ?? wechatClientId(agentName ?? this.defaultAgentName),
      localRuntime: true,
      runnerEnabled: true,
    };
  }

  /**
   * Arm or revive the iLink monitor after a confirmed binding. Pending and
   * disabled shadows remain inert; an enabled real winner may use this
   * awaited, idempotent hook when its status panel is reopened.
   */
  private async fireBindFinalised(agentName: string): Promise<void> {
    const hook = this.onBindFinalised;
    if (!hook) return;
    const current = await this.store.get(agentName);
    // Keep the trusted-family resolver in the path even for a live winner:
    // a manual reserved row must still fail closed before any adapter starts.
    // Once the persisted row is enabled, connected, real and polling, it is
    // already the reconciler's sole winner and may use the idempotent monitor
    // revive hook on a later status-panel reopen.
    const primaryFamily = await this.store.isPrimaryFamilyAgent(agentName);
    if (!isUsableWeChatBinding(current)) {
      logger.info(
        { agentName, platform: 'wechat', primaryFamily },
        'WeChat bind finalizer delegated to family reconciler',
      );
      return;
    }
    await hook(agentName);
  }

  /**
   * Direct bind path — caller supplies a real `botToken`. Used by automation /
   * tests that already hold an iLink token. Interactive (QR scan) onboard
   * MUST go through `startBind` / `bindStatus`.
   */
  async bind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const bound = await this.bindBody(body);
    if ('error' in bound) return bound.error;
    // A direct token is already a confirmed credential, so it needs the same
    // exact adapter/client edge as QR confirmation. `fireBindFinalised` is
    // idempotent and keeps a staged primary-family candidate delegated to the
    // reconciler; without it non-QR binds persisted successfully but had no
    // exact real outbound client.
    await this.fireBindFinalised(bound.record.agentName);
    return json({ ok: true, ...serializeWeChatBinding(bound.record) });
  }

  /**
   * Real iLink onboard — fetch a fresh QR code, persist a `pending:` binding
   * keyed by the new bindSessionId, and return the QR URL for the UI to
   * render. The UI then polls {@link bindStatus} until the user scans + the
   * status flips to `confirmed` (at which point we own a real bot token).
   *
   * No mock fallback, no auto-generated token: a binding only becomes
   * `connected` after a real scan goes through iLink.
   */
  async startBind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    if (readFirstString(body, ['mode']) === 'mock') {
      return json(
        {
          ok: false,
          status: 'error',
          error: 'mock channel mode is not supported',
          code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
          platform: 'wechat',
          localRuntime: true,
        },
        { status: 400 },
      );
    }
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
      this.defaultAgentName;
    const baseUrl = readFirstString(body, ['baseUrl', 'base_url']);
    const botType = readFirstString(body, ['botType', 'bot_type']);
    const sessionId = this.makeId('wechat_bind');
    const { startBindReal } = await import('./adapters/wechat/wechat-onboard.js');
    try {
      const started = await startBindReal(
        {
          agentName,
          sessionId,
          ...(baseUrl ? { baseUrl } : {}),
          ...(botType ? { botType } : {}),
        },
        this.store,
        this.onboardFetch ? { fetch: this.onboardFetch } : {},
      );
      // `startBindReal` skips QR issuance for an active binding. Re-run the
      // finaliser before confirming so a stale/missing runtime edge revives,
      // and a primary-family resolver conflict still fails closed.
      if (started.alreadyBound) await this.fireBindFinalised(agentName);
      return json({
        ok: true,
        status: started.alreadyBound ? 'confirmed' : 'pending',
        sessionId: started.sessionId,
        qrcode: started.qrcode,
        qrcodeUrl: started.qrcodeUrl,
        isImageData: started.isImageData,
        ...(started.alreadyBound ? { connected: true } : {}),
        platform: 'wechat',
        clientId: wechatClientId(agentName),
        localRuntime: true,
      });
    } catch (err) {
      if (err instanceof PrimaryAgentChannelConflictError) return primaryAgentConflictResponse();
      if (err instanceof LocalAgentContractError) throw err;
      return json(
        {
          ok: false,
          status: 'error',
          // iLink errors can include request URLs or provider diagnostics.
          // Keep the stable public error opaque so a failed QR request never
          // reflects credential-bearing details back to Desktop.
          error: 'WeChat QR request failed',
          code: 'WECHAT_ILINK_QR_FAILED',
          platform: 'wechat',
          localRuntime: true,
        },
        { status: 502 },
      );
    }
  }

  /**
   * Real iLink status long-poll — invoked by the UI to learn whether the
   * pending QR was scanned + confirmed. On `confirmed` we finalise the
   * binding (real `botToken` / `ilinkBotId`) and report it back.
   *
   * `pending` / `scanned` / `confirmed` / `expired` are normal 200 states.
   * Provider failures return the opaque `WECHAT_ILINK_QR_FAILED` 502 contract;
   * primary-family conflicts and monitor-start failures retain their 409/503
   * contracts so the UI can re-read rather than falsely confirm a bind.
   */
  async bindStatus(requestUrl: URL): Promise<Response> {
    const sessionId =
      requestUrl.searchParams.get('sessionId') ??
      requestUrl.searchParams.get('session_id') ??
      undefined;
    if (!sessionId) {
      return json(
        { status: 'error', error: 'sessionId is required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      );
    }
    const record = await this.store.getByBindSessionId(sessionId);
    if (!record) {
      return json({
        status: 'expired',
        sessionId,
        error: 'WeChat bind session is not found',
        code: 'WECHAT_BIND_SESSION_NOT_FOUND',
        localRuntime: true,
      });
    }
    // Already confirmed — short-circuit without re-polling iLink.
    if (isUsableWeChatBinding(record)) {
      // Revive the inbound monitor on this path too. A binding can be
      // `connected` on disk while its iLink long-poll is dead (network drop
      // → session_expired, or a desktop restart that never re-armed it).
      // Re-opening the bind panel hits this short-circuit; fire the
      // finalised hook so the adapter force-restarts the monitor and the
      // bot starts receiving again without the user re-scanning.
      await this.fireBindFinalised(record.agentName);
      return json({
        status: 'confirmed',
        sessionId,
        qrcodeUrl: record.qrcodeUrl,
        isImageData: false,
        platform: 'wechat',
        clientId: record.clientId,
        connected: true,
        localRuntime: true,
      });
    }
    const { pollBindStatusReal } = await import('./adapters/wechat/wechat-onboard.js');
    let polled: Awaited<ReturnType<typeof pollBindStatusReal>>;
    try {
      polled = await pollBindStatusReal(
        {
          sessionId,
          agentName: record.agentName,
          ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
        },
        this.store,
        this.onboardFetch ? { fetch: this.onboardFetch } : {},
      );
    } catch (err) {
      if (err instanceof PrimaryAgentChannelConflictError) {
        return primaryAgentConflictResponse();
      }
      if (err instanceof LocalAgentContractError) throw err;
      return weChatIlinkQrFailureResponse();
    }
    if (polled.status === 'confirmed') {
      // Arm the monitor before reporting confirmation. A transport failure is
      // an explicit 503 contract, never a false-positive `confirmed` state.
      await this.fireBindFinalised(record.agentName);
      return json({
        status: 'confirmed',
        sessionId,
        qrcodeUrl: record.qrcodeUrl,
        isImageData: false,
        platform: 'wechat',
        clientId: polled.clientId,
        connected: true,
        localRuntime: true,
      });
    }
    if (polled.status === 'scanned') {
      return json({
        status: 'scanned',
        sessionId,
        qrcodeUrl: record.qrcodeUrl,
        platform: 'wechat',
        clientId: record.clientId,
        connected: false,
        localRuntime: true,
      });
    }
    if (polled.status === 'expired') {
      return json({
        status: 'expired',
        sessionId,
        error: polled.error,
        platform: 'wechat',
        clientId: record.clientId,
        connected: false,
        localRuntime: true,
      });
    }
    if (polled.status === 'error') {
      return weChatIlinkQrFailureResponse();
    }
    // pending
    return json({
      status: 'pending',
      sessionId,
      qrcodeUrl: record.qrcodeUrl,
      isImageData: false,
      platform: 'wechat',
      clientId: record.clientId,
      connected: false,
      localRuntime: true,
    });
  }

  /**
   * Direct-token bind body — requires a real `botToken`. Interactive QR
   * onboard goes through `startBind` instead (no token at start time).
   */
  async bindBody(
    body: Record<string, unknown>,
  ): Promise<{ record: LocalWeChatBindingRecord } | { error: Response }> {
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
      this.defaultAgentName;
    const botToken = readFirstString(body, ['botToken', 'token']);
    if (!botToken) {
      return {
        error: json(
          {
            ok: false,
            error: 'botToken is required',
            code: 'VALIDATION_ERROR',
            platform: 'wechat',
            localRuntime: true,
          },
          { status: 400 },
        ),
      };
    }
    const requestedMode = readFirstString(body, ['mode']);
    if (requestedMode === 'mock') {
      return {
        error: json(
          {
            ok: false,
            error: 'mock channel mode is not supported',
            code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
            platform: 'wechat',
            localRuntime: true,
          },
          { status: 400 },
        ),
      };
    }
    if (requestedMode && requestedMode !== 'polling') {
      return {
        error: json(
          {
            ok: false,
            error: 'unsupported channel mode',
            code: 'VALIDATION_ERROR',
            platform: 'wechat',
            localRuntime: true,
          },
          { status: 400 },
        ),
      };
    }
    const record = await this.store.bind({
      agentName,
      botToken,
      ilinkBotId: readFirstString(body, ['ilinkBotId', 'ilink_bot_id', 'botId', 'bot_id']),
      baseUrl: readFirstString(body, ['baseUrl', 'base_url']),
      webhookToken: readFirstString(body, ['webhookToken', 'webhook_token', 'verificationToken']),
      botName: readFirstString(body, ['botName', 'bot_name', 'name']),
      bindSessionId: readFirstString(body, ['bindSessionId', 'bind_session_id']),
      qrcodeUrl: readFirstString(body, ['qrcodeUrl', 'qrCodeUrl', 'qr_code_url']),
      mode: 'polling',
      // A direct-token bind is by definition already connected.
      connected: true,
    });
    return { record };
  }

  async unbind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
      this.defaultAgentName;
    // Stop the iLink inbound monitor BEFORE deleting the store record so an
    // in-flight long-poll result cannot dispatch after the binding is gone.
    // Idempotent + scoped to this exact agentName (never a default fallback).
    await this.onUnbind?.(agentName);
    const unbound = await this.store.unbind(agentName);
    if (unbound && this.ownerStore) {
      // Clear the owner under BOTH key conventions:
      //   1. `wechatClientId(agentName)` → `wechat:<agent>` (daemon-local key).
      //   2. the imGateway inbound key `${agentName}:wechat` → WeChat inbound
      //      events flow through the Electron imGateway, which records the owner
      //      under `mavis:wechat` (im-runtime-bridge.ts:238). This api had no
      //      ownerStore handle before, so neither key was ever cleared on unbind.
      await clearOwnerAllConventions(
        this.ownerStore,
        agentName,
        'wechat',
        wechatClientId(agentName),
      );
    }
    return json({
      ok: true,
      unbound,
      disconnected: unbound,
      platform: 'wechat',
      clientId: wechatClientId(agentName),
      localRuntime: true,
    });
  }

  async handleEvent(
    request: Request,
    dispatch: boolean,
    requireBinding = false,
  ): Promise<Response> {
    const body = await readJsonBody(request);
    if (requireBinding) {
      const gate = await this.assertBinding(body);
      if (gate) return gate;
    }
    const envelope = parseLocalWeChatEvent(body, this.defaultAgentName);
    if ('error' in envelope) return envelope.error;
    if (dispatch) {
      // Resolve inbound attachments (iLink downloader). Best-effort: a
      // failed download becomes a marker attachment with
      // `error: 'iLink_api_pending'` instead of an exception — the
      // main message must still flow through to the agent loop.
      const attachments = await resolveWeChatAttachments(envelope.attachmentRefs, {
        messageId: envelope.eventId ?? '',
        contextToken: readFirstString(body, ['contextToken', 'context_token']),
        botToken: readFirstString(body, ['botToken', 'bot_token', 'token']),
        sessionId: envelope.eventId ?? '',
        clientName: envelope.ctx.clientName,
      });
      return json(
        await this.runner.dispatchInbound({
          ctx: envelope.ctx,
          text: envelope.text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        }),
      );
    }
    return json({ ok: true, envelope, localRuntime: true });
  }

  private async assertBinding(body: Record<string, unknown>): Promise<Response | undefined> {
    const agentName =
      readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ??
      this.defaultAgentName;
    const record = await this.store.get(agentName);
    if (!isUsableWeChatBinding(record)) {
      return json(
        {
          ok: false,
          error: 'WeChat binding is not configured',
          code: 'WECHAT_BINDING_REQUIRED',
          platform: 'wechat',
          clientId: wechatClientId(agentName),
          localRuntime: true,
        },
        { status: 401 },
      );
    }
    const token = readWeChatWebhookToken(body);
    if (record.webhookToken && token !== record.webhookToken) {
      return json(
        {
          ok: false,
          error: 'WeChat webhook token mismatch',
          code: 'WECHAT_VERIFICATION_FAILED',
          platform: 'wechat',
          clientId: record.clientId,
          localRuntime: true,
        },
        { status: 401 },
      );
    }
    return undefined;
  }
}

/**
 * A persisted QR placeholder or rollback row is not a transport credential.
 * Keep every send-facing gate fail-closed on this one predicate.
 */
export function isUsableWeChatBinding(
  record: LocalWeChatBindingRecord | undefined,
): record is LocalWeChatBindingRecord & {
  enabled: true;
  connected: true;
  mode: 'polling';
} {
  if (!record?.enabled || !record.connected || record.mode !== 'polling') return false;
  return Boolean(record.botToken.trim()) && !isPendingWeChatBindingToken(record.botToken);
}

function isPendingWeChatBindingToken(botToken: string | undefined): boolean {
  return botToken?.startsWith('pending:') === true;
}

function primaryAgentConflictResponse(): Response {
  return json(
    {
      ok: false,
      status: 'conflict',
      error: 'WeChat binding conflicts with an existing primary Agent channel',
      code: PRIMARY_AGENT_CHANNEL_CONFLICT,
      platform: 'wechat',
      localRuntime: true,
    },
    { status: 409 },
  );
}

function weChatIlinkQrFailureResponse(): Response {
  return json(
    {
      ok: false,
      status: 'error',
      error: 'WeChat QR request failed',
      code: 'WECHAT_ILINK_QR_FAILED',
      platform: 'wechat',
      localRuntime: true,
    },
    { status: 502 },
  );
}

export function parseLocalWeChatEvent(
  body: Record<string, unknown>,
  defaultAgentName = 'mavis',
): LocalWeChatEnvelope | { error: Response } {
  const normalized = normalizeWeChatMessageEvent(body);
  if (!normalized) {
    return {
      error: json(
        { error: 'WeChat message event is required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  if (!normalized.chatId || !normalized.senderId) {
    return {
      error: json(
        { error: 'WeChat chat id and sender id are required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  const agentName =
    readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ?? defaultAgentName;
  const botName = readFirstString(body, ['botName', 'bot_name', 'name']);
  const clientName =
    readFirstString(body, ['clientName', 'clientId', 'client_id']) ?? wechatClientId(agentName);
  return {
    ctx: {
      platform: 'wechat',
      chatType: normalized.chatType,
      chatId: normalized.chatId,
      senderId: normalized.senderId,
      clientName,
      ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
      ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
      hasMention:
        body.hasMention === true ||
        body.mentioned === true ||
        normalized.chatType === 'p2p' ||
        wechatTextMentionsBot(normalized.text, botName),
    },
    text: stripWeChatBotMention(normalized.text, botName),
    attachmentRefs: extractWeChatAttachmentRefs(body),
    ...(normalized.eventId ? { eventId: normalized.eventId } : {}),
  };
}

export function wechatClientId(agentName: string): string {
  return `wechat:${agentName.trim() || 'mavis'}`;
}

interface NormalizedWeChatMessageEvent {
  eventId?: string;
  chatType: string;
  chatId?: string;
  senderId?: string;
  threadId?: string;
  text: string;
}

function normalizeWeChatMessageEvent(
  body: Record<string, unknown>,
): NormalizedWeChatMessageEvent | undefined {
  const payload = isRecord(body.payload) ? body.payload : body;
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = firstRecord(event, ['message', 'msg']) ?? event;
  if (!isRecord(message)) return undefined;
  const senderId =
    readFirstString(message, ['from_user_id', 'fromUserId', 'senderId', 'sender_id', 'open_id']) ??
    readFirstString(event, ['from_user_id', 'fromUserId', 'senderId', 'sender_id', 'open_id']);
  const groupId = readFirstString(message, ['group_id', 'groupId']);
  const chatType = normalizeWeChatChatType(
    readFirstString(message, ['chat_type', 'chatType']) ?? (groupId ? 'group' : 'p2p'),
  );
  const chatId =
    readFirstString(message, ['chat_id', 'chatId']) ?? (chatType === 'group' ? groupId : senderId);
  const text = extractWeChatText(message);
  if (!text && !chatId && !senderId) return undefined;
  return {
    eventId:
      stringish(message.message_id) ?? stringish(message.client_id) ?? stringish(payload.event_id),
    chatType,
    chatId,
    senderId,
    threadId: readFirstString(message, ['session_id', 'sessionId']),
    text,
  };
}

function extractWeChatText(message: Record<string, unknown>): string {
  const direct = readFirstString(message, ['text', 'content', 'message']);
  if (direct) return direct;
  const content = message.content;
  if (typeof content === 'string') {
    const parsed = safeJson(content);
    if (isRecord(parsed)) return extractWeChatText(parsed);
    return content;
  }
  const items = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(message.items)
      ? message.items
      : [];
  return items
    .map((item) => {
      if (!isRecord(item)) return undefined;
      const type = item.type;
      if (type === 1 || type === 'text') {
        const textItem = isRecord(item.text_item) ? item.text_item : item;
        return readFirstString(textItem, ['text', 'content']);
      }
      if (type === 3 || type === 'voice') {
        const voiceItem = isRecord(item.voice_item) ? item.voice_item : item;
        return readFirstString(voiceItem, ['text']);
      }
      return undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function wechatTextMentionsBot(text: string, botName?: string): boolean {
  if (!botName) return false;
  const normalized = botName.replace(/^@/u, '').toLowerCase();
  return text.toLowerCase().includes(`@${normalized}`);
}

/**
 * Strip a leading/inline `@<bot>` mention from a WeChat inbound text so slash
 * commands parse in group chats. When a member @-mentions the bot, WeChat
 * inserts `@<nickname>` followed by whitespace (a regular space or the
 * four-per-em space U+2005), so a command arrives as `@bot<space>/new` — which
 * does not start with `/` and would be treated as a normal message. Mirrors
 * Feishu's mention normalisation + Telegram's `stripTelegramBotMention` so all
 * three IM platforms handle group commands consistently. No-op when the bot
 * name is unknown or unmentioned.
 */
function stripWeChatBotMention(text: string, botName?: string): string {
  if (!botName) return text;
  const handle = botName.replace(/^@/u, '');
  if (!handle) return text;
  const stripped = text
    .replace(new RegExp(`@${escapeWeChatRegExp(handle)}[\\s\\u2005]*`, 'giu'), '')
    .trim();
  return stripped || text;
}

function escapeWeChatRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// ---------------------------------------------------------------------------
// Inbound attachment handling
// ---------------------------------------------------------------------------
//
// WeChat iLink does not yet expose a documented "download inbound attachment"
// endpoint — see `progress/wechat-ilink-api-pending.md` and the stub in
// `apps/electron/main/modules/imGateway/wechat-sdk/ilink-download.ts`.
//
// To keep the local-runtime package self-contained (it cannot import from
// the electron app), we mirror the stub pattern here:
//
//   1. `extractWeChatAttachmentRefs` parses the inbound `item_list` and
//      produces `ChannelInboundAttachmentRef` values. The `key` field
//      carries whatever opaque identifier iLink gave us (typically
//      `media.encrypt_query_param`).
//   2. `resolveWeChatAttachments` iterates over those refs, calls the
//      injected `WeChatAttachmentDownloader`, and produces
//      `LocalMessageAttachment[]`. On failure it marks the attachment
//      with `error: 'iLink_api_pending'` so the agent loop sees a
//      marker instead of a half-formed file.
//   3. The default downloader is the stub below — it rejects every call
//      with the TODO error. Tests replace it via
//      `setWeChatAttachmentDownloader(...)` inside `beforeEach` /
//      `afterEach`. The production wire-up happens at electron startup
//      (the electron app injects the real implementation into
//      local-runtime's slot).
//
// This mirrors the Feishu P1-B and Telegram P1-C error-handling shape
// (downloader rejection → marker attachment, never throw, never block
// dispatch).
//
// P2-A note: the downloader signature changed from the P1 1-arg form to
// a 2-arg `(ref, ctx)` form so the resolver can hand the downloader
// the inbound `context_token` and the local-runtime `sessionId` for
// on-disk scoping without re-reading the original event. See
// `progress/im-genui-p2a-delivery-2026-06-18.md` for the rationale and
// the 3 items business still needs to confirm.

/** Sentinel error code attached to attachments that couldn't be downloaded. */
export const WECHAT_ILINK_API_PENDING_ERROR = 'iLink_api_pending';

/**
 * Public alias for the Feishu / Telegram convention. Future-proofs the
 * runner-level error handling so the platform-agnostic side can read
 * `attachment.error` and react without knowing the platform.
 */
export const WECHAT_ILINK_API_PENDING_ERROR_MESSAGE =
  '[TODO] iLink download API not confirmed; see https://vrfi1sk8a0.feishu.cn/docx/WRBtdsLHxovVLyxQ8cTcmlwMnIf for spec';

/**
 * Runtime context handed to the downloader alongside the ref.
 *
 * Mirrors `WeChatDownloadContext` from
 * `apps/electron/main/modules/imGateway/wechat-sdk/ilink-download.ts`,
 * minus the fields electron owns (e.g. `botToken` lives on the
 * inbound event body, not on the envelope — so the resolver doesn't
 * forward it through the downloader context).
 */
export interface WeChatDownloadContext {
  /** Inbound message id from the WeChat event. */
  messageId: string;
  /**
   * Local-runtime session id. The downloader writes the file under
   * `<dataDir>/tmp/im-attachments/{sessionId}/`; an empty string means
   * the inbound hasn't been assigned a session yet (caller can fall
   * back to a default sub-directory).
   */
  sessionId: string;
  /** `wechat:<agent>` client name; matches `LocalChannelContext.clientName`. */
  clientName: string;
  /**
   * iLink `context_token` echoed from the inbound WeixinMessage. The
   * real downloader may need to forward it as a header / query / body
   * field — see `progress/wechat-ilink-api-pending.md` question #1.
   */
  contextToken?: string;
  /** Bot token bound to this WeChat client; required by the iLink CDN. */
  botToken?: string;
  /** CDN base URL from the binding (`baseurl` returned by iLink onboard). */
  baseUrl?: string;
}

/**
 * Public contract for a WeChat attachment downloader.
 *
 * Two-argument shape (ref first, context second) so the downloader can
 * be a free function or a closure — no hidden captures. `ctx` carries
 * the `sessionId` for on-disk scoping and the inbound `context_token`
 * without requiring the downloader to re-parse the original
 * WeixinMessage.
 *
 * Implementations MUST reject (not resolve) on failure; the resolver
 * turns every rejection into a marker attachment and never re-throws.
 */
export type WeChatAttachmentDownloader = (
  ref: ChannelInboundAttachmentRef,
  ctx: WeChatDownloadContext,
) => Promise<{ filePath: string; mimeType: string; byteLength: number }>;

/**
 * Default stub — rejects with the TODO error. Used when no real
 * downloader has been installed via `setWeChatAttachmentDownloader`.
 *
 * Exported separately so tests can verify the default rejection
 * contract without poking at module-level state.
 */
export const defaultWeChatAttachmentDownloader: WeChatAttachmentDownloader = async () => {
  throw new Error(WECHAT_ILINK_API_PENDING_ERROR_MESSAGE);
};

/**
 * Module-level injection slot. Defaults to
 * `defaultWeChatAttachmentDownloader`; overridden by
 * `setWeChatAttachmentDownloader` at runtime (electron startup hook)
 * or in tests (beforeEach).
 *
 * Parallel to the same name in
 * `apps/electron/main/modules/imGateway/wechat-sdk/ilink-download.ts`:
 * the two module-level slots are intentionally separate (local-runtime
 * cannot import from the electron app), but their signatures are
 * structurally compatible so the electron app can install a real
 * downloader in either slot at boot.
 */
let currentDownloader: WeChatAttachmentDownloader = defaultWeChatAttachmentDownloader;

/**
 * Replace the WeChat attachment downloader. Pass `undefined` to reset
 * to the default pending-API stub. The electron app calls this once
 * at startup; tests call it inside `beforeEach` / `afterEach`.
 */
export function setWeChatAttachmentDownloader(fn: WeChatAttachmentDownloader | undefined): void {
  currentDownloader = fn ?? defaultWeChatAttachmentDownloader;
}

/**
 * Read the currently installed downloader. Returns
 * `defaultWeChatAttachmentDownloader` when nothing has been installed;
 * never `undefined`.
 *
 * Exposed alongside `setWeChatAttachmentDownloader` so the
 * local-runtime resolver — and any future wrapper (retry /
 * dead-letter) — can read the *current* function reference instead of
 * importing a hard-coded stub.
 */
export function getWeChatAttachmentDownloader(): WeChatAttachmentDownloader {
  return currentDownloader;
}

/**
 * Sentinel item-type codes from `ilink-types.MessageItemType`:
 *   TEXT=1, IMAGE=2, VOICE=3, FILE=4, VIDEO=5.
 * Kept as a local constant so the parser doesn't have to import from
 * the electron app.
 */
const WECHAT_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/**
 * Walk the inbound message's `item_list` and produce one
 * `ChannelInboundAttachmentRef` per non-text attachment. Returns
 * `[]` when there are no attachments or the message shape is
 * unrecognized.
 */
export function extractWeChatAttachmentRefs(
  body: Record<string, unknown>,
): ChannelInboundAttachmentRef[] {
  const payload = isRecord(body.payload) ? body.payload : body;
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = firstRecord(event, ['message', 'msg']) ?? event;
  if (!isRecord(message)) return [];
  const items = Array.isArray(message.item_list)
    ? message.item_list
    : Array.isArray(message.items)
      ? message.items
      : [];
  const refs: ChannelInboundAttachmentRef[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const type = item.type;
    if (type === WECHAT_ITEM_TYPE.IMAGE && isRecord(item.image_item)) {
      const media: Record<string, unknown> = isRecord(item.image_item.media)
        ? item.image_item.media
        : {};
      // iLink ships the image aes-key as a 32-char hex string under
      // `image_item.aeskey`, but the CDN downloader's `parseAesKey` expects
      // base64. Convert here so inbound image download doesn't fail with
      // `aes_key must decode to 16 raw bytes or 32-char hex string, got 24
      // bytes` (parity with historical `imGateway/platforms/wechat.ts`).
      const rawAesHex = readFirstString(item.image_item, ['aeskey']);
      const rawAesB64 = readFirstString(media, ['aes_key']);
      const aesKey = normalizeWeChatAesKey(rawAesHex, rawAesB64);
      const encryptedQueryParam =
        readFirstString(media, ['encrypt_query_param']) ??
        readFirstString(item.image_item, ['url']);
      const key = encodeWeChatAttachmentKey({ encryptedQueryParam, aesKey });
      if (!key) continue;
      refs.push({
        type: 'image',
        key,
        ...(aesKey ? { name: 'image.jpg', mimeType: 'image/jpeg' } : {}),
      });
      continue;
    }
    if (type === WECHAT_ITEM_TYPE.FILE && isRecord(item.file_item)) {
      const media: Record<string, unknown> = isRecord(item.file_item.media)
        ? item.file_item.media
        : {};
      const key = encodeWeChatAttachmentKey({
        encryptedQueryParam: readFirstString(media, ['encrypt_query_param']),
        aesKey: readFirstString(media, ['aes_key']),
      });
      if (!key) continue;
      const name = readFirstString(item.file_item, ['file_name']) ?? 'file';
      refs.push({
        type: 'file',
        key,
        name,
        mimeType: 'application/octet-stream',
      });
      continue;
    }
    if (type === WECHAT_ITEM_TYPE.VOICE && isRecord(item.voice_item)) {
      const media: Record<string, unknown> = isRecord(item.voice_item.media)
        ? item.voice_item.media
        : {};
      const key = encodeWeChatAttachmentKey({
        encryptedQueryParam: readFirstString(media, ['encrypt_query_param']),
        aesKey: readFirstString(media, ['aes_key']),
      });
      if (!key) continue;
      refs.push({
        type: 'audio',
        key,
        name: 'voice.silk',
        mimeType: 'audio/silk',
      });
      continue;
    }
    if (type === WECHAT_ITEM_TYPE.VIDEO && isRecord(item.video_item)) {
      const media: Record<string, unknown> = isRecord(item.video_item.media)
        ? item.video_item.media
        : {};
      const key = encodeWeChatAttachmentKey({
        encryptedQueryParam: readFirstString(media, ['encrypt_query_param']),
        aesKey: readFirstString(media, ['aes_key']),
      });
      if (!key) continue;
      refs.push({
        type: 'video',
        key,
        name: 'video.mp4',
        mimeType: 'video/mp4',
      });
      continue;
    }
  }
  return refs;
}

export function encodeWeChatAttachmentKey(input: {
  encryptedQueryParam?: string;
  aesKey?: string;
}): string {
  const encryptedQueryParam = input.encryptedQueryParam?.trim() ?? '';
  if (!encryptedQueryParam) return '';
  const aesKey = input.aesKey?.trim() ?? '';
  return aesKey ? `${aesKey}|${encryptedQueryParam}` : encryptedQueryParam;
}

export function decodeWeChatAttachmentKey(key: string): {
  encryptedQueryParam: string;
  aesKey: string;
} {
  const idx = key.indexOf('|');
  if (idx < 0) return { encryptedQueryParam: key, aesKey: '' };
  return { aesKey: key.slice(0, idx), encryptedQueryParam: key.slice(idx + 1) };
}

/**
 * Pick the right aes-key encoding for the CDN downloader:
 *   - `media.aes_key` is base64(raw 16) — pass through
 *   - `image_item.aeskey` is hex(raw 16) — re-encode to base64
 *
 * The CDN helper's `parseAesKey` only accepts base64 (of either the raw
 * 16-byte key or its 32-char hex form). Without this normalisation, inbound
 * images fail to decrypt with `aes_key must decode to 16 raw bytes or
 * 32-char hex string, got 24 bytes` (24 = `Buffer.from(<hex>, 'base64')`
 * misreading the hex as base64). Parity with historical
 * `imGateway/platforms/wechat.ts` which performed the identical
 * `Buffer.from(aeskey, 'hex').toString('base64')` round-trip.
 */
export function normalizeWeChatAesKey(
  rawHex: string | undefined,
  rawBase64: string | undefined,
): string | undefined {
  if (rawHex && /^[0-9a-fA-F]{32}$/.test(rawHex)) {
    return Buffer.from(rawHex, 'hex').toString('base64');
  }
  if (rawBase64) return rawBase64;
  return rawHex;
}

/**
 * Persist an inbound WeChat attachment buffer under
 * `<dataDir>/tmp/im-attachments/<scope>/<ts>-<file>` and return the absolute
 * path. Mirrors the Telegram downloader's on-disk convention so the agent
 * loop can hand the file to v2 input materialization the same way.
 */
export async function writeWeChatAttachmentFile(input: {
  dataDir: string;
  scopeDirName: string;
  fileName: string;
  buffer: Buffer;
}): Promise<string> {
  const scope = sanitizeAttachmentSegment(input.scopeDirName || 'wechat');
  const safeName = sanitizeAttachmentSegment(input.fileName || 'attachment');
  const dir = join(input.dataDir, 'tmp', 'im-attachments', scope);
  await mkdir(dir, { recursive: true });
  const target = join(dir, `${Date.now()}-${safeName}`);
  await writeFile(target, input.buffer, { mode: 0o600 });
  return target;
}

function sanitizeAttachmentSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_') || 'attachment';
}

/**
 * Resolve a list of `ChannelInboundAttachmentRef` into
 * `LocalMessageAttachment[]`. Failed downloads are turned into
 * marker attachments with `error: 'iLink_api_pending'` so the main
 * message still flows through to the agent loop.
 */
export async function resolveWeChatAttachments(
  refs: ChannelInboundAttachmentRef[],
  context: {
    messageId: string;
    contextToken?: string;
    botToken?: string;
    baseUrl?: string;
    sessionId?: string;
    clientName?: string;
    downloader?: WeChatAttachmentDownloader;
  },
): Promise<LocalMessageAttachment[]> {
  if (refs.length === 0) return [];
  const results = await Promise.all(
    refs.map(async (ref) => resolveOneWeChatAttachment(ref, context)),
  );
  return results;
}

async function resolveOneWeChatAttachment(
  ref: ChannelInboundAttachmentRef,
  context: {
    messageId: string;
    contextToken?: string;
    botToken?: string;
    baseUrl?: string;
    sessionId?: string;
    clientName?: string;
    downloader?: WeChatAttachmentDownloader;
  },
): Promise<LocalMessageAttachment> {
  const baseType: LocalMessageAttachment['type'] = ref.type === 'image' ? 'image' : 'file';
  const fallbackName = ref.name ?? `${ref.type}-${context.messageId}`;
  const fallbackMime = ref.mimeType ?? 'application/octet-stream';
  const dlqMeta = {
    platform: 'wechat' as const,
    sessionId: context.sessionId ?? '',
    messageId: context.messageId,
    refKind: mapChannelRefTypeToDlqRefKind(ref.type),
    refKey: ref.key,
  };
  try {
    // P2-B: Wrap each download with withRetry + DLQ. The default iLink_api_pending is a business-level
    // pending state that cannot self-recover; isPermanentError sends it directly to DLQ once, without retries.
    // Once a real implementation is wired, HTTP 5xx / network interruptions use exponential backoff.
    const downloader = context.downloader ?? currentDownloader;
    const result = await withRetry(
      () =>
        downloader(ref, {
          messageId: context.messageId,
          sessionId: context.sessionId ?? '',
          clientName: context.clientName ?? '',
          ...(context.contextToken ? { contextToken: context.contextToken } : {}),
          ...(context.botToken ? { botToken: context.botToken } : {}),
          ...(context.baseUrl ? { baseUrl: context.baseUrl } : {}),
        }),
      {
        maxAttempts: 3,
        backoffMs: [500, 1500, 5000],
        isPermanentError: (err: unknown) => isIlinkApiPendingError(err),
      },
      makeDeadLetterCallback(wechatDeadLetterStore, dlqMeta),
    );
    return {
      type: baseType,
      filePath: result.filePath,
      fileName: fallbackName,
      mimeType: result.mimeType || fallbackMime,
    };
  } catch {
    return {
      type: baseType,
      filePath: '',
      fileName: fallbackName,
      mimeType: fallbackMime,
      error: WECHAT_ILINK_API_PENDING_ERROR,
    };
  }
}

/**
 * P2-B: Both default iLink errors contain "iLink" and mean the business integration is not yet
 * confirmed. Treat both as permanent without retries. Once a real implementation is wired, these
 * keywords disappear and standard HTTP 4xx/5xx classification applies.
 */
function isIlinkApiPendingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes('iLink_api_pending') ||
    msg.includes(WECHAT_ILINK_API_PENDING_ERROR_MESSAGE) ||
    msg.includes('iLink download API not confirmed')
  );
}

/** ChannelInboundAttachmentRef.type (image | file | audio | video) → DLQ refKind。 */
function mapChannelRefTypeToDlqRefKind(
  type: ChannelInboundAttachmentRef['type'],
): DeadLetterRefKind {
  switch (type) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'voice';
    case 'file':
    default:
      return 'file';
  }
}

// ---------------------------------------------------------------------------
// P2-B dead-letter queue (DLQ): persist failure context for inbound iLink downloads.
// ---------------------------------------------------------------------------

/**
 * Module-level DLQ store handle. Default `undefined` means no DLQ writes (silent no-op), honoring
 * the contract that an unconfigured DLQ stays silent. Production callers inject it when
 * constructing `LocalRuntimeApiHost`.
 *
 * Mirror of the same name in `apps/electron/main/modules/imGateway/wechat-sdk/ilink-download.ts`:
 * the two module-level slots are intentionally separate (local-runtime cannot import from the
 * electron app), but their signatures are structurally compatible so the same store can be
 * installed into either slot at boot.
 */
let wechatDeadLetterStore: LocalDeadLetterStore | undefined;

/**
 * Install the WeChat iLink DLQ store. Pass `undefined` to detach.
 * Production callers (electron startup hook, or the `LocalRuntimeApiHost`
 * initializer) call this once at boot; tests inject a spy store to assert
 * the DLQ entry shape.
 */
export function setWeChatDeadLetterStore(store: LocalDeadLetterStore | undefined): void {
  wechatDeadLetterStore = store;
}

/**
 * Read the currently installed DLQ store. Exposed so callers (and tests)
 * can introspect which store is wired in. Returns `undefined` when nothing
 * has been installed.
 */
export function getWeChatDeadLetterStore(): LocalDeadLetterStore | undefined {
  return wechatDeadLetterStore;
}

function readWeChatWebhookToken(body: Record<string, unknown>): string | undefined {
  const header = isRecord(body.header) ? body.header : undefined;
  return (
    readFirstString(body, ['token', 'webhookToken', 'webhook_token', 'verificationToken']) ??
    (header
      ? readFirstString(header, ['token', 'webhookToken', 'webhook_token', 'verificationToken'])
      : undefined)
  );
}

function normalizeWeChatChatType(value: unknown): string {
  if (value === 'group' || value === 'p2p') return value;
  if (value === 'private') return 'p2p';
  return typeof value === 'string' && value.trim() ? value.trim() : 'p2p';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function stringish(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}
