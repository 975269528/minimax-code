import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename as pathBasename, dirname, join } from 'node:path';
import yaml from 'js-yaml';

import { json, readFirstString, readJsonBody } from '../api/http-helpers.js';
import { imLogger as logger } from '../common/im-logger.js';
import type { LocalChannelRunner } from './runner.js';
import type { ChannelInboundEnvelope } from './envelope.js';
import type { LocalChannelOwnerStore } from './owner-store.js';
import { clearOwnerAllConventions } from './owner-store.js';
import type {
  ChannelFamilyMutationHook,
  ChannelFamilyMutationKind,
} from './channel-family-mutation.js';
import type { LocalMessageAttachment, LocalMessageQuotedMessage } from '../messages/input.js';
import { LocalFeishuChannelClient } from './feishu-outbound-client.js';
import { extractFeishuAttachmentRefs } from './feishu-attachments.js';
import { isUsableFeishuBinding } from './adapters/feishu/feishu-adapter-utils.js';
import type {
  FeishuBotIdentity,
  FeishuMessageSnapshot,
  FeishuSenderOptions,
} from './adapters/feishu/feishu-sender.js';

export interface LocalFeishuBindingRecord {
  clientId: string;
  agentName: string;
  appId: string;
  appSecret: string;
  verificationToken?: string;
  /**
   * Feishu event encrypt key (a.k.a. `encrypt_token`). Used to decrypt
   * encrypted event callbacks. Audit B9: the bind path previously dropped
   * this on the floor; it is now read from the bind body and persisted so
   * webhook decryption can be wired later. Never echoed in serialized
   * responses (masked-out, like the app secret).
   */
  encryptKey?: string;
  botName?: string;
  connected: boolean;
  enabled: boolean;
  mode: 'mock' | 'webhook' | 'websocket';
  createdAt: number;
  updatedAt: number;
}

interface LocalFeishuChannelFile {
  schemaVersion: number;
  bindings: Record<string, LocalFeishuBindingRecord>;
}

export type LocalFeishuEnvelope = ChannelInboundEnvelope & {
  /**
   * Feishu thread id (`omt_…`) whose root message should be fetched as quoted
   * context. This is a thread container id, NOT a message id, so it must be
   * resolved via the thread-container listing, not `GET /im/v1/messages/{id}`.
   */
  quotedThreadId?: string;
};

export type FeishuQuotedMessageResolver = (input: {
  threadId: string;
  envelope: LocalFeishuEnvelope;
}) => Promise<LocalMessageQuotedMessage | undefined>;

/**
 * Best-effort resolver for a binding's real Feishu bot display name (app name),
 * used to overlay the placeholder label stored at onboard time. Returns
 * `undefined` when the live lookup is unavailable.
 */
export type FeishuBotNameResolver = (
  record: LocalFeishuBindingRecord,
) => Promise<string | undefined>;

export class LocalFeishuChannelStore {
  // Promise-based dedup so concurrent first-touch callers (eager
  // `startFeishuWs()` + `restoreInboundLoops()` both firing at host
  // construction) all await the same in-flight read. The previous
  // boolean `loaded` was flipped synchronously before the I/O resolved,
  // which let a second caller see `loaded === true` and skip the read —
  // returning a half-populated `bindings` map (`records: 0` even when
  // the YAML on disk was valid). See fix/feishu-store-load-race.
  private loadPromise: Promise<void> | null = null;
  private readonly bindings = new Map<string, LocalFeishuBindingRecord>();
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
    appId: string;
    appSecret: string;
    verificationToken?: string;
    encryptKey?: string;
    botName?: string;
    mode?: 'webhook' | 'websocket';
    /** Internal state-only import: persist without invoking the live family hook. */
    suppressFamilyMutation?: boolean;
  }): Promise<LocalFeishuBindingRecord> {
    await this.load();
    const agentName = input.agentName.trim();
    const clientId = feishuClientId(agentName);
    const existing = this.bindings.get(clientId);
    const now = this.nowMs();
    // A primary-family candidate is staged disabled: the reconciler below is
    // the only writer allowed to enable a family record, so a crash between
    // this save and the reconcile leaves "no transport", never two.
    const primaryFamily =
      input.suppressFamilyMutation !== true && (await this.isPrimaryFamilyAgent(agentName));
    const record: LocalFeishuBindingRecord = {
      clientId,
      agentName,
      appId: input.appId.trim(),
      appSecret: input.appSecret.trim(),
      ...(input.verificationToken?.trim()
        ? { verificationToken: input.verificationToken.trim() }
        : {}),
      ...(input.encryptKey?.trim() ? { encryptKey: input.encryptKey.trim() } : {}),
      ...(input.botName?.trim() ? { botName: input.botName.trim() } : {}),
      connected: true,
      enabled: !primaryFamily,
      mode:
        input.mode ??
        (existing?.mode === 'webhook' || existing?.mode === 'websocket'
          ? existing.mode
          : 'websocket'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.bindings.set(clientId, record);
    await this.save();
    if (primaryFamily) {
      await this.familyHook?.afterMutation({ agentName, kind: 'bind' });
    }
    // Re-read: the reconcile may have enabled this record (canonical winner) or
    // left it disabled (legacy shadow). Callers gate transport start on it.
    return { ...(this.bindings.get(clientId) ?? record) };
  }

  async unbind(
    agentName: string,
    options?: { suppressFamilyMutation?: boolean },
  ): Promise<boolean> {
    await this.load();
    const trimmed = agentName.trim();
    const existing = this.bindings.get(feishuClientId(trimmed));
    const deleted = this.bindings.delete(feishuClientId(trimmed));
    if (deleted) await this.save();
    if (
      existing &&
      deleted &&
      options?.suppressFamilyMutation !== true &&
      (await this.isPrimaryFamilyAgent(trimmed, 'unbind')) === true
    ) {
      const identity = existing.appId.trim();
      await this.familyHook?.afterMutation({
        agentName: trimmed,
        kind: 'unbind',
        unbound: { enabled: existing.enabled, ...(identity ? { identity } : {}) },
      });
    }
    return deleted;
  }

  /**
   * Copy one binding's whole credential group onto another agentName (plan
   * §5.3: never merge two credentials field by field). Narrow on purpose — the
   * reconciler is the only caller and the raw YAML map stays private.
   */
  async cloneBindingForAgent(input: {
    fromAgentName: string;
    toAgentName: string;
    enabled: boolean;
  }): Promise<LocalFeishuBindingRecord | undefined> {
    await this.load();
    const source = this.bindings.get(feishuClientId(input.fromAgentName.trim()));
    if (!source) return undefined;
    const toAgentName = input.toAgentName.trim();
    const clientId = feishuClientId(toAgentName);
    const existing = this.bindings.get(clientId);
    const record: LocalFeishuBindingRecord = {
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
  ): Promise<LocalFeishuBindingRecord | undefined> {
    await this.load();
    const clientId = feishuClientId(agentName.trim());
    const existing = this.bindings.get(clientId);
    if (!existing) return undefined;
    if (existing.enabled === enabled) return { ...existing };
    const record: LocalFeishuBindingRecord = { ...existing, enabled, updatedAt: this.nowMs() };
    this.bindings.set(clientId, record);
    await this.save();
    return { ...record };
  }

  async get(agentName: string): Promise<LocalFeishuBindingRecord | undefined> {
    await this.load();
    const record = this.bindings.get(feishuClientId(agentName.trim()));
    return record ? { ...record } : undefined;
  }

  async list(): Promise<LocalFeishuBindingRecord[]> {
    await this.load();
    return [...this.bindings.values()]
      .sort((a, b) => a.clientId.localeCompare(b.clientId))
      .map((record) => ({ ...record }));
  }

  private load(): Promise<void> {
    // Concurrent callers (eager WS start + restoreInboundLoops fire in
    // the same tick) all await the same in-flight read instead of racing
    // on a boolean flag. On failure the promise is cleared so the next
    // caller retries — useful for transient FS errors (EAGAIN, etc.).
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad().catch((err: unknown) => {
      this.loadPromise = null;
      const code = err && typeof err === 'object' ? (err as NodeJS.ErrnoException).code : undefined;
      logger.error(
        {
          errorName: err instanceof Error ? err.name : typeof err,
          ...(typeof code === 'string' ? { code } : {}),
          platform: 'feishu',
        },
        'Feishu binding store load failed',
      );
      throw err;
    });
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    // ENOENT is a valid first-boot state (no yaml yet) — keep it quiet.
    // Permission / I/O errors surface so the wrapper can log + retry.
    const raw = await readFile(this.filePath, 'utf8').catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    });
    if (!raw) return;
    const parsed = yaml.load(raw) as Partial<LocalFeishuChannelFile> | null;
    const bindings = parsed?.bindings;
    if (!bindings || typeof bindings !== 'object') return;
    for (const [clientId, value] of Object.entries(bindings)) {
      const record = normalizeFeishuBinding(clientId, value);
      if (record) this.bindings.set(record.clientId, record);
    }
  }

  private async save(): Promise<void> {
    const payload: LocalFeishuChannelFile = {
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
    return join(this.dataDir(), 'feishu-channel.yaml');
  }
}

/**
 * Pluggable attachment downloader for the Feishu webhook path.
 *
 * The webhook handler in LocalFeishuChannelApi.handleEvent runs in the
 * local-runtime host process and does NOT have direct access to the
 * IMGateway LarkClient (which lives in the Electron main process and uses
 * the WS-backed SDK). To keep the channel-bridge platform-agnostic, the
 * downloader is injected by the host wiring code: the host exposes a
 * thin IPC for inbound attachment downloads.
 *
 * The contract:
 *   - messageId is the platform message id (Feishu message_id).
 *   - fileKey is the resource key (image_key for image messages,
 *     file_key for file / audio / video messages, or image_key from
 *     a post rich-text inline image).
 *   - type is the resource type as Feishu reports it. image / file
 *     are the only types Feishu messageResource.get accepts via the
 *     SDK; for audio and video Feishu uses type=file and a magic-byte
 *     sniff tells the formats apart.
 *   - sessionId scopes the local tmp directory so P1-E can prune
 *     whole session trees cheaply.
 *   - Returns the absolute local file path, OR throws on failure. The
 *     webhook handler catches and marks the attachment with
 *     error=download_failed so the inbound dispatch still proceeds
 *     with whatever attachments DID succeed.
 */
export type FeishuAttachmentDownloader = (input: {
  messageId: string;
  fileKey: string;
  type: 'image' | 'file' | 'audio' | 'video';
  sessionId: string;
}) => Promise<string>;

export class LocalFeishuChannelApi {
  constructor(
    private readonly store: LocalFeishuChannelStore,
    private readonly runner: LocalChannelRunner,
    private readonly defaultAgentName: string,
    private readonly ownerStore?: LocalChannelOwnerStore,
    /**
     * Optional attachment downloader. When provided, webhook events that
     * carry Feishu image_key / file_key references are resolved to
     * local LocalMessageAttachment instances before dispatch. Failures
     * are isolated: a single failed download does NOT block the
     * message — the attachment is marked with error=download_failed
     * and the dispatch proceeds.
     */
    private readonly attachmentDownloader?: FeishuAttachmentDownloader,
    private readonly onBindingChanged?: (record: LocalFeishuBindingRecord) => void | Promise<void>,
    /**
     * Optional in-memory map of pending "🤔 Thinking…" cards (keyed by chatId),
     * shared with the WS dispatcher. When set, the outbound client patches
     * the stored card into the final reply card instead of stacking a new
     * bubble.
     */
    private readonly pendingThinkingStore?: import('./adapters/feishu/feishu-ws.js').FeishuPendingThinkingStore,
    /**
     * Optional hook fired after the outbound client renders a Card 2.0 form
     * questionnaire. Wired by the host so a chat-action callback can map the
     * submit back to the originating `AskQuestionnaireRequest`.
     */
    private readonly onQuestionnaireRendered?: import('./feishu-outbound-client.js').FeishuQuestionnaireRenderedHook,
    /** Best-effort resolver for Feishu root/parent message quoted context. */
    private readonly quotedMessageResolver?: FeishuQuotedMessageResolver,
    /** Best-effort resolver for a binding's real Feishu bot display name. */
    private readonly botNameResolver?: FeishuBotNameResolver,
    /**
     * Optional per-agent transport teardown hook. Wired by the host to
     * `getOrCreateFeishuAdapter(agentName).invalidateTransport()`. Called at
     * the TOP of `unbindBody` — BEFORE `store.unbind` — so the inbound WS is
     * torn down while the record still exists (closing the "record deleted but
     * in-flight WS event still lands" window). Idempotent + null-safe: a
     * missing / already-closed transport is a no-op. Scoped strictly to the
     * agentName being unbound so a sibling agent's WS is never touched.
     */
    private readonly onUnbind?: (agentName: string) => void | Promise<void>,
    /**
     * Optional live WS transport status provider, wired by the host to
     * `getOrCreateFeishuAdapter(agentName).getWsStatus()`. Lets status/list
     * responses carry the in-memory `wsStatus` (idle/connecting/connected/
     * error + optional `wsLastError`) alongside the persisted `connected`
     * flag — the stored flag only proves bind once succeeded, not that the
     * transport is alive right now.
     */
    private readonly wsStatusProvider?: (
      agentName: string,
    ) => import('./adapters/feishu/feishu-adapter.js').FeishuWsStatusInfo,
    /**
     * Optional shared store of pending 👀 `OnIt` ack reactions (keyed by
     * inbound messageId), written by the WS dispatcher. Threaded into the
     * outbound clients this API registers so the ack is revoked once the
     * final reply has been delivered.
     */
    private readonly pendingReactionStore?: import('./adapters/feishu/feishu-ws.js').FeishuPendingReactionStore,
  ) {}

  registerClient(record?: LocalFeishuBindingRecord, senderOptions: FeishuSenderOptions = {}): void {
    if (!isUsableFeishuBinding(record)) return;
    const agentName = record?.agentName ?? this.defaultAgentName;
    const client = new LocalFeishuChannelClient(
      this.runner.outboundStore,
      this.store,
      agentName,
      senderOptions,
      this.pendingThinkingStore,
      this.pendingReactionStore,
      this.onQuestionnaireRendered,
      feishuClientId(agentName),
    );
    this.runner.clients.registerExact(client);
  }

  async statusClients(): Promise<Record<string, unknown>> {
    const clients: Record<string, unknown> = {};
    for (const record of await this.store.list()) {
      const resolved = await this.resolveRealBotName(record);
      clients[record.clientId] = serializeFeishuBinding(resolved, this.resolveWsStatus(resolved));
    }
    return clients;
  }

  /**
   * Resolve the live WS transport status for a binding. Convention:
   * non-websocket bindings (webhook / mock) report `'idle'` — they have no
   * WS transport by design, so the additive `wsStatus` field must not read
   * as an outage. Missing provider (tests / minimal wiring) → undefined and
   * the field is omitted entirely.
   */
  private resolveWsStatus(
    record: LocalFeishuBindingRecord,
  ): import('./adapters/feishu/feishu-adapter.js').FeishuWsStatusInfo | undefined {
    if (!this.wsStatusProvider) return undefined;
    if (record.mode !== 'websocket') return { status: 'idle' };
    try {
      return this.wsStatusProvider(record.agentName);
    } catch {
      return undefined;
    }
  }

  /**
   * Overlay a binding's real Feishu bot display name (app name) onto its stored
   * record for status reporting. The name captured at onboard time is a fixed
   * placeholder, so we look it up live (cached in the sender). Failures are
   * non-fatal: the stored value is returned unchanged.
   */
  private async resolveRealBotName(
    record: LocalFeishuBindingRecord,
  ): Promise<LocalFeishuBindingRecord> {
    if (!this.botNameResolver || !record.appId || !record.appSecret) return record;
    let liveName: string | undefined;
    try {
      liveName = await this.botNameResolver(record);
    } catch {
      return record;
    }
    if (!liveName || liveName === record.botName) return record;
    return { ...record, botName: liveName };
  }

  async configCheck(agentName?: string): Promise<Record<string, unknown>> {
    const record = await this.store.get(agentName ?? this.defaultAgentName);
    return {
      configured: Boolean(record?.appId && record.appSecret),
      source: record ? 'local-runtime' : null,
      hasCredentials: Boolean(record?.appId && record.appSecret),
      platform: 'feishu',
      clientId: record?.clientId ?? feishuClientId(agentName ?? this.defaultAgentName),
      localRuntime: true,
      runnerEnabled: true,
    };
  }

  async bind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const bound = await this.bindBody(body);
    if ('error' in bound) return bound.error;
    return json({
      ok: true,
      ...serializeFeishuBinding(bound.record, this.resolveWsStatus(bound.record)),
    });
  }

  async bindBody(
    body: Record<string, unknown>,
  ): Promise<{ record: LocalFeishuBindingRecord } | { error: Response }> {
    const agentName = readFeishuAgentName(body, this.defaultAgentName);
    const appId = readFirstString(body, ['appId', 'app_id']);
    const appSecret = readFirstString(body, ['appSecret', 'app_secret']);
    if (!appId || !appSecret) {
      return {
        error: json(
          {
            ok: false,
            error: 'appId and appSecret are required',
            code: 'VALIDATION_ERROR',
            localRuntime: true,
          },
          { status: 400 },
        ),
      };
    }
    const requestedMode = readFirstString(body, ['mode']);
    if (requestedMode === 'mock') return unsupportedMockMode('feishu');
    if (requestedMode && requestedMode !== 'webhook' && requestedMode !== 'websocket') {
      return invalidBindMode('feishu');
    }
    const record = await this.store.bind({
      agentName,
      appId,
      appSecret,
      verificationToken: readFirstString(body, [
        'verificationToken',
        'verification_token',
        'token',
      ]),
      encryptKey: readFirstString(body, [
        'encryptKey',
        'encrypt_key',
        'encryptToken',
        'encrypt_token',
      ]),
      botName: readFirstString(body, ['botName', 'bot_name']),
      mode: requestedMode === 'webhook' ? 'webhook' : 'websocket',
    });
    // Plan §5.2: bind no longer starts its own transport unconditionally. A
    // staged / non-winner record (primary-family loser, or a candidate the
    // reconciler left disabled) must reach neither registry nor the WS start.
    if (record.enabled === false || (await this.store.isPrimaryFamilyAgent(agentName))) {
      logger.info(
        { agentName, platform: 'feishu' },
        'Feishu bind transport start delegated to family reconciler',
      );
      return { record };
    }
    this.registerClient(record);
    await this.onBindingChanged?.(record);
    return { record };
  }

  async unbind(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    return this.unbindBody(body);
  }

  async hasBindingBody(body: Record<string, unknown>): Promise<boolean> {
    const agentName = readFeishuAgentName(body, this.defaultAgentName);
    return Boolean(await this.store.get(agentName));
  }

  async unbindBody(body: Record<string, unknown>): Promise<Response> {
    const agentName = readFeishuAgentName(body, this.defaultAgentName);
    // Stop the inbound WS transport BEFORE deleting the store record so an
    // in-flight event cannot land after the binding is gone. Idempotent +
    // scoped to this exact agentName (never a default/empty fallback).
    await this.onUnbind?.(agentName);
    const unbound = await this.store.unbind(agentName);
    if (unbound && this.ownerStore) {
      // Clear the owner under BOTH key conventions:
      //   1. `feishuClientId(agentName)` — the bare agentName, the key the
      //      daemon-local path uses when bootstrapping ownership.
      //   2. the imGateway inbound key `${agentName}:feishu` — Feishu inbound
      //      events flow through the Electron imGateway, which records the owner
      //      under `mavis:feishu` (im-runtime-bridge.ts:238). The old code only
      //      cleared key (1), so the imGateway-stored owner survived unbind and
      //      denied a re-binding user with `access-control:owner_only`.
      await clearOwnerAllConventions(
        this.ownerStore,
        agentName,
        'feishu',
        feishuClientId(agentName),
      );
    }
    return json({
      ok: true,
      unbound,
      disconnected: unbound,
      platform: 'feishu',
      clientId: feishuClientId(agentName),
      localRuntime: true,
    });
  }

  async handleEvent(
    request: Request,
    dispatch: boolean,
    requireBinding = false,
  ): Promise<Response> {
    const body = await readJsonBody(request);
    if (isFeishuUrlVerification(body)) {
      const gate = requireBinding ? await this.assertBinding(body) : undefined;
      if (gate) return gate;
      return json({ challenge: body.challenge, localRuntime: true });
    }
    if (requireBinding) {
      const gate = await this.assertBinding(body);
      if (gate) return gate;
    }
    const envelope = parseLocalFeishuEvent(body, this.defaultAgentName);
    if ('error' in envelope) return envelope.error;
    if (dispatch) {
      // P1-B: resolve attachment refs to local files before dispatching.
      // Best-effort: a failed download marks that attachment with
      // `error: 'download_failed'` but the message still flows.
      const attachments = await this.resolveAttachments(envelope);
      const quotedMessage = await this.resolveQuotedMessage(envelope);
      return json(
        await this.runner.dispatchInbound({
          ctx: envelope.ctx,
          text: envelope.text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(quotedMessage ? { quotedMessage } : {}),
          ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        }),
      );
    }
    return json({ ok: true, envelope, localRuntime: true });
  }

  /**
   * Resolve Feishu attachment refs to local `LocalMessageAttachment` with
   * `filePath` populated. Refs are downloaded concurrently with
   * `Promise.all`; a single failure does NOT reject the whole batch.
   *
   * Order semantics:
   *   1. Filter to refs that have a usable `fileKey` and a session
   *      identifier (chatId acts as sessionId for the webhook path).
   *   2. Run downloads in parallel.
   *   3. Map successes to LocalMessageAttachment with `filePath`.
   *   4. Map failures to LocalMessageAttachment with
   *      `error: 'download_failed'` (still a non-fatal placeholder).
   *
   * When no downloader is configured (e.g. unit tests, mock harness), or
   * the envelope has no refs, returns an empty array.
   */
  private async resolveAttachments(
    envelope: LocalFeishuEnvelope,
  ): Promise<LocalMessageAttachment[]> {
    const refs = envelope.attachmentRefs ?? [];
    if (refs.length === 0) return [];
    if (!this.attachmentDownloader) return [];

    const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
    const results = await Promise.all(
      refs.map(async (ref): Promise<LocalMessageAttachment> => {
        if (!ref.key) {
          return {
            type: ref.type === 'image' ? 'image' : 'file',
            filePath: '',
            fileName: ref.name ?? 'attachment',
            mimeType: ref.mimeType ?? 'application/octet-stream',
            dataUrl: undefined,
            assetId: undefined,
            // Surface as a missing-attachment marker; downstream layers
            // (LocalMessageInput) will see the empty filePath and skip
            // the binary read.
          };
        }
        try {
          const filePath = await this.attachmentDownloader!({
            // §4.5: Feishu resource API is keyed by message_id, NOT event_id.
            // Fall back to eventId only when the upstream parser failed to
            // expose message_id, which yields HTTP 404 — at that point the
            // download failure is reported via the catch below.
            messageId: envelope.messageId ?? envelope.eventId ?? '',
            fileKey: ref.key,
            type: ref.type,
            sessionId,
          });
          return {
            type: ref.type === 'image' ? 'image' : 'file',
            filePath,
            fileName: ref.name ?? pathBasename(filePath),
            mimeType: ref.mimeType ?? 'application/octet-stream',
          };
        } catch {
          return {
            type: ref.type === 'image' ? 'image' : 'file',
            filePath: '',
            fileName: ref.name ?? ref.key ?? 'attachment',
            mimeType: ref.mimeType ?? 'application/octet-stream',
            // P1-B failure marker (per P1-D's LocalMessageAttachment.error
            // contract). `message` is intentionally dropped from the
            // shape — agents see a stable sentinel and can map it to
            // a user-friendly line in the prompt loader.
            error: 'download_failed',
            dataUrl: undefined,
            assetId: undefined,
          };
        }
      }),
    );
    return results;
  }

  private async resolveQuotedMessage(
    envelope: LocalFeishuEnvelope,
  ): Promise<LocalMessageQuotedMessage | undefined> {
    if (envelope.quotedMessage) return envelope.quotedMessage;
    if (!envelope.quotedThreadId || !this.quotedMessageResolver) return undefined;
    try {
      return await this.quotedMessageResolver({
        threadId: envelope.quotedThreadId,
        envelope,
      });
    } catch {
      // Quoted context is helpful but non-critical: never block the inbound
      // turn because Feishu message-history permissions/API are unavailable.
      return undefined;
    }
  }

  private async assertBinding(body: Record<string, unknown>): Promise<Response | undefined> {
    const agentName = readFeishuAgentName(body, this.defaultAgentName);
    const record = await this.store.get(agentName);
    if (!record?.enabled || !record.appId || !record.appSecret) {
      return json(
        {
          ok: false,
          error: 'Feishu binding is not configured',
          code: 'FEISHU_BINDING_REQUIRED',
          platform: 'feishu',
          clientId: feishuClientId(agentName),
          localRuntime: true,
        },
        { status: 401 },
      );
    }
    const token = readFeishuVerificationToken(body);
    if (record.verificationToken && token !== record.verificationToken) {
      return json(
        {
          ok: false,
          error: 'Feishu verification token mismatch',
          code: 'FEISHU_VERIFICATION_FAILED',
          platform: 'feishu',
          clientId: record.clientId,
          localRuntime: true,
        },
        { status: 401 },
      );
    }
    return undefined;
  }
}

export function parseLocalFeishuEvent(
  body: Record<string, unknown>,
  defaultAgentName = 'mavis',
  botIdentity?: FeishuBotIdentity,
): LocalFeishuEnvelope | { error: Response } {
  const normalized = normalizeFeishuMessageEvent(body);
  if (!normalized) {
    return {
      error: json(
        { error: 'Feishu message event is required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  const chatId = normalized.chatId;
  const senderId = normalized.senderId ?? chatId;
  if (!chatId || !senderId) {
    return {
      error: json(
        { error: 'Feishu chat_id and sender id are required', code: 'VALIDATION_ERROR' },
        { status: 400 },
      ),
    };
  }
  const agentName = readFeishuAgentName(body, defaultAgentName);
  const botName = readFirstString(body, ['botName', 'bot_name', 'name']) ?? botIdentity?.name;
  const resolvedBotIdentity = botName ? { ...botIdentity, name: botName } : botIdentity;
  const clientName =
    readFirstString(body, ['clientName', 'clientId', 'client_id']) ?? feishuClientId(agentName);
  const text = normalizeFeishuMentionText(
    extractFeishuText(normalized.content),
    normalized.mentions,
    resolvedBotIdentity,
    normalized.senderName,
  );
  const mentionAll =
    feishuMentionsAll(normalized.mentions) || textContainsFeishuMentionAll(normalized.content);
  // P1-B: extract attachment refs (image / file / audio / video) from
  // the message so the inbound handler can resolve them to local files
  // before dispatch. The actual download is best-effort and decoupled
  // from parseLocalFeishuEvent so unit tests don't need a network.
  const attachmentRefs = extractFeishuAttachmentRefs(
    body,
    normalized.messageType,
    normalized.content,
  );
  // A thread/topic (`thread_id`/`root_id`) is what we fetch as quoted context:
  // the thread id resolves to the topic's root message. A bare `parent_id`
  // (quoted reply outside a thread) is intentionally NOT treated as a thread —
  // see `normalizeFeishuMessageEvent`.
  const quotedThreadId =
    normalized.threadId && normalized.threadId !== normalized.messageId
      ? normalized.threadId
      : undefined;
  return {
    ctx: {
      platform: 'feishu',
      chatType: normalizeFeishuChatType(normalized.chatType),
      chatId,
      senderId,
      clientName,
      ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
      ...(normalized.messageId ? { sourceMessageId: normalized.messageId } : {}),
      ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
      hasMention:
        body.hasMention === true ||
        body.mentioned === true ||
        normalizeFeishuChatType(normalized.chatType) === 'p2p' ||
        feishuMentionsBot(normalized.mentions, resolvedBotIdentity),
      ...(mentionAll ? { mentionAll: true } : {}),
    },
    text,
    attachmentRefs,
    ...(normalized.eventId ? { eventId: normalized.eventId } : {}),
    ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
    ...(quotedThreadId ? { quotedThreadId } : {}),
  };
}

export function feishuClientId(agentName: string): string {
  return agentName.trim() || 'mavis';
}

export function readFeishuAgentName(
  body: Record<string, unknown>,
  defaultAgentName: string,
): string {
  const explicit = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
  if (explicit) return explicit;
  const name = readFirstString(body, ['name']);
  if (name && !isFeishuPlatformName(name)) return name;
  return defaultAgentName;
}

function isFeishuPlatformName(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'feishu' || normalized === 'lark';
}

function serializeFeishuBinding(
  record: LocalFeishuBindingRecord,
  /**
   * Optional live WS transport status (additive fields `wsStatus` /
   * `wsLastError`). Omitted when the caller has no status provider so
   * existing consumers of the shape are unaffected.
   */
  wsStatus?: import('./adapters/feishu/feishu-adapter.js').FeishuWsStatusInfo,
): Record<string, unknown> {
  return {
    ok: true,
    platform: 'feishu',
    clientId: record.clientId,
    agentName: record.agentName,
    appId: record.appId,
    connected: record.connected,
    enabled: record.enabled,
    mode: record.mode,
    appSecretMasked: maskSecret(record.appSecret),
    hasCredentials: Boolean(record.appId && record.appSecret),
    localRuntime: true,
    ...(record.verificationToken
      ? { verificationTokenMasked: maskSecret(record.verificationToken) }
      : {}),
    ...(record.botName ? { botName: record.botName } : {}),
    ...(wsStatus
      ? {
          wsStatus: wsStatus.status,
          ...(wsStatus.lastError ? { wsLastError: wsStatus.lastError } : {}),
        }
      : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function normalizeFeishuBinding(
  fallbackClientId: string,
  value: unknown,
): LocalFeishuBindingRecord | undefined {
  if (!isRecord(value)) return undefined;
  const agentName = readFirstString(value, ['agentName', 'agentId', 'agent']);
  const appId = readFirstString(value, ['appId', 'app_id']);
  const appSecret = readFirstString(value, ['appSecret', 'app_secret']);
  if (!agentName || !appId || !appSecret) return undefined;
  return {
    clientId: readFirstString(value, ['clientId']) ?? fallbackClientId,
    agentName,
    appId,
    appSecret,
    ...(readFirstString(value, ['verificationToken'])
      ? { verificationToken: readFirstString(value, ['verificationToken']) }
      : {}),
    ...(readFirstString(value, ['encryptKey', 'encrypt_key', 'encryptToken', 'encrypt_token'])
      ? {
          encryptKey: readFirstString(value, [
            'encryptKey',
            'encrypt_key',
            'encryptToken',
            'encrypt_token',
          ]),
        }
      : {}),
    ...(readFirstString(value, ['botName'])
      ? { botName: readFirstString(value, ['botName']) }
      : {}),
    ...normalizePersistedFeishuState(value),
    createdAt: readNumber(value.createdAt) ?? Date.now(),
    updatedAt: readNumber(value.updatedAt) ?? Date.now(),
  };
}

interface NormalizedFeishuMessageEvent {
  eventId?: string;
  chatId?: string;
  chatType?: string;
  senderId?: string;
  senderName?: string;
  content?: unknown;
  mentions?: unknown;
  /** Thread/topic root ID — present only for messages inside a Feishu thread. */
  threadId?: string;
  /** Direct quoted-reply parent ID — present for quote replies (not threads). */
  parentId?: string;
  messageType?: string;
  messageId?: string;
}

function normalizeFeishuMessageEvent(
  body: Record<string, unknown>,
): NormalizedFeishuMessageEvent | undefined {
  const payload = isRecord(body.payload) ? body.payload : body;
  const event = isRecord(payload.event) ? payload.event : payload;
  const message = isRecord(event.message) ? event.message : event;
  if (!isRecord(message) && !readFirstString(event, ['chat_id', 'chatId'])) return undefined;
  const sender = isRecord(event.sender) ? event.sender : {};
  const senderIdRecord = isRecord(sender.sender_id) ? sender.sender_id : {};
  return {
    eventId:
      stringish(payload.event_id) ?? stringish(body.event_id) ?? stringish(message.message_id),
    chatId: readFirstString(message, ['chat_id', 'chatId']),
    chatType: readFirstString(message, ['chat_type', 'chatType']),
    senderId:
      readFirstString(event, ['sender_id', 'senderId']) ??
      readFirstString(senderIdRecord, ['open_id', 'user_id', 'union_id']),
    senderName: readFeishuSenderName(event, message, sender),
    content: message.content,
    mentions: message.mentions,
    // `thread_id` (and the legacy `root_id`) mark a message that lives inside a
    // Feishu thread/topic. `parent_id` alone (a quoted reply outside a thread)
    // must NOT be treated as a thread — otherwise every quote reply would spawn
    // an isolated session and get answered in-thread by mistake.
    threadId: readFirstString(message, ['thread_id', 'threadId', 'root_id', 'rootId']),
    parentId: readFirstString(message, ['parent_id', 'parentId']),
    messageType: readFirstString(message, ['message_type', 'messageType']),
    messageId: readFirstString(message, ['message_id', 'messageId']),
  };
}

export function feishuMessageSnapshotToQuotedMessage(
  snapshot: FeishuMessageSnapshot | undefined,
): LocalMessageQuotedMessage | undefined {
  if (!snapshot) return undefined;
  const text = describeFeishuQuotedContent(snapshot);
  if (!text) return undefined;
  const quoted: LocalMessageQuotedMessage = { text };
  const senderName = snapshot.senderName?.trim() || feishuSenderFallback(snapshot.senderId);
  if (senderName) quoted.senderName = senderName;
  return quoted;
}

function describeFeishuQuotedContent(snapshot: FeishuMessageSnapshot): string {
  const text = extractFeishuText(snapshot.content).trim();
  if (text) return text;
  switch (snapshot.messageType) {
    case 'image':
      return '[图片]';
    case 'audio':
      return '[语音]';
    case 'media':
    case 'video':
      return '[视频]';
    case 'file':
      return '[文件]';
    default:
      return '';
  }
}

function feishuSenderFallback(senderId: string | undefined): string | undefined {
  if (!senderId) return undefined;
  const suffix = senderId.slice(-6);
  return suffix ? `User ${suffix}` : undefined;
}

/**
 * Pull Feishu attachment refs out of a parsed event.
 *
 * Recognised sources (in priority order):
 *   1. Top-level `image_key` / `file_key` on the message content (image,
 *      file, audio, video single-resource messages). The resource type is
 *      derived from `messageType`; audio and video both use `file_key`
 *      but we tag them as `audio` / `video` so the downloader picks the
 *      right decoder hint.
 *   2. Inline `img` entries in `post` rich-text messages (each carries
 *      an `image_key` and lives inside a nested `zh_cn` / `en_us` /
 *      top-level `content` array).
 *
 * Other fields (file_name, file size, MIME hints) are forwarded when
 * present so the downloader can use them for hinting. The downloader
 * itself re-sniffs MIME from the buffer, so the hint is best-effort.
 */
export { extractFeishuAttachmentRefs } from './feishu-attachments.js';

function extractFeishuText(content: unknown): string {
  if (typeof content === 'string') {
    const parsed = safeJson(content);
    if (isRecord(parsed)) return extractFeishuText(parsed);
    return content;
  }
  if (!isRecord(content)) return '';
  const text = readFirstString(content, ['text', 'title', 'content']);
  if (text) return text;
  const richText = extractNestedFeishuText(content.content);
  if (richText) return richText;
  const elements = Array.isArray(content.elements) ? content.elements : [];
  return elements
    .map((element) =>
      isRecord(element) ? readFirstString(element, ['text', 'content']) : undefined,
    )
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function extractNestedFeishuText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractNestedFeishuText).filter(Boolean).join('\n');
  }
  if (!isRecord(value)) return '';
  const direct = readFirstString(value, ['text', 'title']);
  if (direct) return direct;
  if ('content' in value) {
    const nested = extractNestedFeishuText(value.content);
    if (nested) return nested;
  }
  if ('elements' in value) {
    const nested = extractNestedFeishuText(value.elements);
    if (nested) return nested;
  }
  if (readFirstString(value, ['tag']) === 'img') return '[图片]';
  return '';
}

function normalizeFeishuMentionText(
  text: string,
  mentions: unknown,
  botIdentity?: FeishuBotIdentity,
  senderName?: string,
): string {
  if (!text) return text;
  let next = text;
  let botMentioned = false;
  if (Array.isArray(mentions)) {
    for (const mention of mentions) {
      if (!isRecord(mention)) continue;
      const key = readFirstString(mention, ['key', 'mention_key', 'mentionKey']);
      if (!key) continue;
      if (isFeishuMentionAllKey(key)) {
        next = next.split(key).join('');
        continue;
      }
      const botMention = isBotMention(mention, botIdentity);
      if (botMention) botMentioned = true;
      const replacementName = botMention ? undefined : readFirstString(mention, ['name']);
      const replacement = replacementName ? `@${replacementName.replace(/^@/u, '')}` : '';
      next = next.split(key).join(replacement);
    }
  }
  // Some WS payloads carry the raw @_all placeholder but omit `mentions`.
  next = next.split('@_all').join('');
  const normalized = next.replace(/[ \t]{2,}/gu, ' ').trim();
  if (!botMentioned || !senderName) return normalized;
  const displayName = senderName.replace(/^@/u, '');
  return normalized ? `${normalized} from User ${displayName}` : `from User ${displayName}`;
}

function readFeishuSenderName(
  event: Record<string, unknown>,
  message: Record<string, unknown>,
  sender: Record<string, unknown>,
): string | undefined {
  return (
    readFirstString(event, ['senderName', 'sender_name', 'name', 'nickname']) ??
    readFirstString(message, ['senderName', 'sender_name']) ??
    readFirstString(sender, ['senderName', 'sender_name', 'name', 'nickname'])
  );
}

function feishuMentionsBot(mentions: unknown, botIdentity?: FeishuBotIdentity): boolean {
  if (!Array.isArray(mentions)) return false;
  return mentions.some((mention) => isRecord(mention) && isBotMention(mention, botIdentity));
}

function feishuMentionsAll(mentions: unknown): boolean {
  if (!Array.isArray(mentions)) return false;
  return mentions.some(
    (mention) =>
      isRecord(mention) &&
      isFeishuMentionAllKey(readFirstString(mention, ['key', 'mention_key', 'mentionKey']) ?? ''),
  );
}

function textContainsFeishuMentionAll(content: unknown): boolean {
  return extractFeishuText(content).includes('@_all');
}

function isFeishuMentionAllKey(key: string): boolean {
  return key.trim() === '@_all';
}

function isBotMention(mention: Record<string, unknown>, botIdentity?: FeishuBotIdentity): boolean {
  const mentionId = readFirstString(isRecord(mention.id) ? mention.id : {}, [
    'open_id',
    'user_id',
    'union_id',
  ]);
  if (botIdentity?.openId && mentionId) return mentionId === botIdentity.openId;
  if (!botIdentity?.name) return false;
  const name = readFirstString(mention, ['name']);
  return name?.toLowerCase() === botIdentity.name.replace(/^@/u, '').toLowerCase();
}

function isFeishuUrlVerification(body: Record<string, unknown>): body is Record<string, unknown> & {
  challenge: string;
} {
  return (
    (body.type === 'url_verification' || body.type === 'url_verification_callback') &&
    typeof body.challenge === 'string'
  );
}

function readFeishuVerificationToken(body: Record<string, unknown>): string | undefined {
  const header = isRecord(body.header) ? body.header : undefined;
  return (
    readFirstString(body, ['token', 'verificationToken', 'verification_token']) ??
    (header
      ? readFirstString(header, ['token', 'verificationToken', 'verification_token'])
      : undefined)
  );
}

function normalizeFeishuMode(value: unknown): 'mock' | 'webhook' | 'websocket' {
  return value === 'webhook' || value === 'websocket' ? value : 'mock';
}

function normalizePersistedFeishuState(
  value: Record<string, unknown>,
): Pick<LocalFeishuBindingRecord, 'connected' | 'enabled' | 'mode'> {
  const mode = normalizeFeishuMode(readFirstString(value, ['mode']));
  // Historical mock (and omitted/unknown legacy mode) remains readable so it
  // can be exactly unbound, but it can never be restored as a live transport.
  if (mode === 'mock') return { mode, connected: false, enabled: false };
  return { mode, connected: value.connected !== false, enabled: value.enabled !== false };
}

function unsupportedMockMode(platform: 'feishu'): { error: Response } {
  return {
    error: json(
      {
        ok: false,
        error: 'mock channel mode is not supported',
        code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
        platform,
        localRuntime: true,
      },
      { status: 400 },
    ),
  };
}

function invalidBindMode(platform: 'feishu'): { error: Response } {
  return {
    error: json(
      {
        ok: false,
        error: 'unsupported channel mode',
        code: 'VALIDATION_ERROR',
        platform,
        localRuntime: true,
      },
      { status: 400 },
    ),
  };
}

function normalizeFeishuChatType(value: unknown): string {
  if (value === 'group' || value === 'p2p') return value;
  if (value === 'private') return 'p2p';
  return typeof value === 'string' && value.trim() ? value.trim() : 'p2p';
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

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function maskSecret(secret: string): string {
  if (secret.length <= 6) return '***';
  return `${secret.slice(0, 3)}***${secret.slice(-3)}`;
}
