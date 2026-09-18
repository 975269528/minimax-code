import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelBinding, LocalChannelContext } from './infra.js';
import type { LocalChannelAdapterRegistry } from './adapter-registry.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import { imLogger as logger } from '../common/im-logger.js';

/**
 * Core-layer permission → IM rendering bridge. Structural mirror of
 * `channels/questionnaire-bridge.ts` (see that file for the architectural
 * facts that shape the contract — SSE-only event bus, synchronous outbound
 * hook, in-process pending map keyed by `(platform, clientName, chatId)`).
 *
 * Surface:
 *   - {@link ChannelPermissionOutboundPort.onPermissionAsk} — synchronous
 *     hook called when `LocalPermissionApprovalService.begin(...)` records a fresh
 *     ask. Strict origin routing: the card is rendered ONLY to the binding
 *     that exactly matches the originating turn's IM conversation
 *     (`platform + clientName + chatId`, via the event `origin` or the
 *     host-wired {@link ChannelPermissionBridgeOptions.resolveOrigin});
 *     desktop-initiated turns (no origin) render to no binding at all. The
 *     route layer awaits this hook in a try/catch so a render
 *     failure cannot crash `beforeLocalToolCall`. Render failures are also
 *     isolated per binding inside the hook: one binding's failed render is
 *     logged and skipped (no pending recorded) while the remaining bindings
 *     still receive their cards.
 *   - {@link LocalChannelPermissionBridge.tryPermissionReply} — inbound
 *     callback dispatcher. Returns the resolved request id + decoded
 *     decision so the runner can route the user click into the existing
 *     `replyLocalPermissionRequests` flow.
 *
 * This module is platform-agnostic: it never imports `./feishu` /
 * `./telegram` / `./wechat`; it depends only on the
 * {@link LocalChannelPlatformAdapter} interface via the registry.
 */

// ---------------------------------------------------------------------------
// Types — public to permissions/*, route layer, and Telegram/Feishu adapters.
// ---------------------------------------------------------------------------

/**
 * Outbound hook invoked synchronously when a `permission.ask` is recorded.
 * Permissions facade / routes call this through the `LocalPermissionRouteContext`.
 */
export interface ChannelPermissionOutboundPort {
  onPermissionAsk(event: ChannelPermissionAskEvent): Promise<void>;
}

export interface ChannelPermissionAskEvent {
  requestId: string;
  sessionId: string;
  agentName: string | null;
  request: ChannelPermissionRequestSnapshot;
  /**
   * The IM conversation whose inbound message started the current turn.
   * Absent for desktop/UI-initiated turns — those must never fan the card
   * out to IM bindings (the desktop `permission.ask` Global Event covers them).
   */
  origin?: ChannelPermissionOrigin;
}

/**
 * Identifies the originating IM conversation of a turn. Matches
 * `LocalChannelContext` coordinates; compared exactly against bindings so a
 * WeChat-initiated ask never renders to a Feishu binding bound to the same
 * session.
 */
export interface ChannelPermissionOrigin {
  platform: string;
  clientName: string;
  chatId: string;
  /**
   * Thread/topic the originating inbound message lived in (Telegram forum
   * topic / Feishu thread). Delivery metadata ONLY — binding matching stays
   * on `platform + clientName + chatId`; when present it overrides the
   * binding's own threadId so the card renders inside the originating thread.
   */
  threadId?: string;
}

/**
 * Trimmed view of a `LocalPermissionRequest` carried into the bridge. We do
 * not import `LocalPermissionRequest` to avoid pulling the route-layer type
 * into the core channels package.
 */
export interface ChannelPermissionRequestSnapshot {
  requestId: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  toolDescription?: string;
  toolInput?: string;
  reason: string;
  ruleContents: string[];
  createdAt: number;
}

/**
 * Adapter-facing renderable form. The adapter consumes this flattened shape
 * instead of reaching into the route's `LocalPermissionRequest` so platform
 * code never depends on route internals.
 */
export interface ChannelRenderablePermission {
  requestId: string;
  toolName: string;
  toolDescription?: string;
  toolInput?: string;
  reason: string;
  ruleContents: string[];
}

/**
 * Decision behaviour an adapter may produce from a callback. The bridge
 * maps these to the existing daemon `allowOnce / allowAlways / deny`
 * vocabulary at the route boundary.
 */
export type ChannelPermissionBehavior = 'allow' | 'deny' | 'always';

export interface ChannelPermissionReplyMatch {
  requestId: string;
  behavior: ChannelPermissionBehavior;
}

/**
 * A pending permission ask that has been rendered to a specific IM
 * conversation. Keyed (in the bridge's map) by
 * `(platform, clientName, chatId)` so multiple bot instances never
 * cross-resolve a reply.
 */
export interface LocalChannelPermissionPending {
  requestId: string;
  platform: ChannelPlatform;
  clientName: string;
  chatId: string;
  outboundMessageId?: string;
  request: ChannelPermissionRequestSnapshot;
  createdAt: number;
}

/** Minimal binding-store surface the bridge needs (reverse lookup by session). */
export interface ChannelPermissionBindingLookup {
  list(filter: { sessionId?: string }): Promise<LocalChannelBinding[]>;
}

export interface ChannelPermissionBridgeOptions {
  bindingStore: ChannelPermissionBindingLookup;
  adapterRegistry: LocalChannelAdapterRegistry;
  nowMs: () => number;
  /**
   * Resolve the IM origin of the session's currently running turn. Wired by
   * the host to its per-session turn-origin map (set when a channel-sourced
   * turn starts, cleared when it ends). Consulted when the ask event itself
   * carries no `origin`. Returning `undefined` means the turn was not started
   * from an IM channel → no card is rendered to any binding.
   */
  resolveOrigin?: (sessionId: string) => ChannelPermissionOrigin | undefined;
  /** Optional structured logger; defaults to local-runtime logger facade for failures. */
  logWarn?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * Optional metrics reporter injected by the host. Absent → no metrics
   * (noop), zero behavior change.
   */
  metrics?: ModuleMetricsReporter;
}

/** Flatten a {@link ChannelPermissionRequestSnapshot} into the renderable form. */
export function toRenderablePermission(
  request: ChannelPermissionRequestSnapshot,
): ChannelRenderablePermission {
  return {
    requestId: request.requestId,
    toolName: request.toolName,
    ...(request.toolDescription ? { toolDescription: request.toolDescription } : {}),
    ...(request.toolInput ? { toolInput: request.toolInput } : {}),
    reason: request.reason,
    ruleContents: request.ruleContents,
  };
}

/**
 * Default core bridge. Holds an in-process pending map keyed by
 * `(platform, clientName, chatId)`; implements both the outbound
 * `onPermissionAsk` hook and the inbound `tryPermissionReply` resolver.
 */
export class LocalChannelPermissionBridge implements ChannelPermissionOutboundPort {
  private readonly pending = new Map<string, LocalChannelPermissionPending>();

  constructor(private readonly options: ChannelPermissionBridgeOptions) {}

  async onPermissionAsk(event: ChannelPermissionAskEvent): Promise<void> {
    try {
      // Strict origin routing: a permission card only ever goes back to the
      // exact IM conversation whose message started the current turn.
      // Desktop/UI-initiated turns have no origin → the ask stays on the
      // desktop `permission.ask` Global Event and no IM binding is rendered
      // (previously every binding that matched the session received the card,
      // so a WeChat-initiated ask also popped up in Feishu).
      const origin = event.origin ?? this.options.resolveOrigin?.(event.sessionId);
      if (!origin) return; // desktop-initiated turn: never fan out to IM.
      // raised = the ask targeted an IM channel; delivered = card rendered.
      this.options.metrics?.incr('channel_permission_ask_total', {
        channel: origin.platform,
        phase: 'raised',
      });
      const bindings = (
        await this.options.bindingStore.list({ sessionId: event.sessionId })
      ).filter(
        (binding) =>
          binding.platform === origin.platform &&
          binding.clientName === origin.clientName &&
          binding.chatId === origin.chatId,
      );
      if (bindings.length === 0) return; // origin conversation not bound: safe no-op.
      const renderable = toRenderablePermission(event.request);
      for (const binding of bindings) {
        // Thread-aware delivery: the origin's threadId (the thread the turn
        // actually started in) wins over the binding's stored threadId, so
        // the card lands in the originating thread instead of the top-level
        // chat. Matching above never looks at threadId.
        const ctx = {
          ...bindingToContext(binding),
          ...(origin.threadId ? { threadId: origin.threadId } : {}),
        };
        const adapter = this.options.adapterRegistry.getForContext(ctx);
        if (!adapter?.renderPermission) continue; // adapter not wired yet: degrade.
        // Per-binding isolation: one binding's render failure (e.g. a stale
        // placeholder binding whose chatId the platform rejects) must not
        // starve the remaining bindings of their permission cards. A failed
        // render records NO pending — an undelivered card must never consume
        // a future reply.
        try {
          const { outboundMessageId } = await adapter.renderPermission({ ctx, renderable });
          this.pending.set(this.keyFor(ctx.platform, ctx.clientName, ctx.chatId), {
            requestId: event.requestId,
            platform: ctx.platform,
            clientName: ctx.clientName,
            chatId: ctx.chatId,
            ...(outboundMessageId ? { outboundMessageId } : {}),
            request: event.request,
            createdAt: this.options.nowMs(),
          });
          this.options.metrics?.incr('channel_permission_ask_total', {
            channel: ctx.platform,
            phase: 'delivered',
          });
        } catch (err) {
          this.warn('permission render failed for binding', {
            requestId: event.requestId,
            platform: ctx.platform,
            clientName: ctx.clientName,
            chatId: ctx.chatId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      this.warn('permission onAsk failed', {
        requestId: event.requestId,
        sessionId: event.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Never throw: a render failure must not crash the permission ask path
      // (binding-store lookup failures land here; per-binding render failures
      // are isolated in the loop above).
    }
  }

  /**
   * Try to interpret an inbound platform callback as a reply to a pending
   * permission ask for this conversation. Returns the parsed reply (for the
   * caller to feed into `replyLocalPermissionRequests`) or `null` when the
   * message is not a permission reply.
   */
  async tryPermissionReply(
    ctx: LocalChannelContext,
    raw: unknown,
  ): Promise<ChannelPermissionReplyMatch | null> {
    const key = this.keyFor(ctx.platform, ctx.clientName, ctx.chatId);
    const pending = this.pending.get(key);
    if (!pending) return null;
    const adapter = this.options.adapterRegistry.getForContext(ctx);
    if (!adapter?.parsePermissionReply) return null;
    let reply: { behavior: ChannelPermissionBehavior } | null;
    try {
      reply = await adapter.parsePermissionReply({ raw, pending });
    } catch (err) {
      this.warn('permission parseReply failed', {
        requestId: pending.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!reply) return null;
    this.pending.delete(key);
    return { requestId: pending.requestId, behavior: reply.behavior };
  }

  /** Drop a pending entry once its reply has been resolved/dismissed elsewhere. */
  forget(platform: ChannelPlatform, clientName: string, chatId: string): void {
    this.pending.delete(this.keyFor(platform, clientName, chatId));
  }

  /** Drop every rendered ask owned by a Session that is being deleted. */
  forgetSession(sessionId: string): number {
    let deleted = 0;
    for (const [key, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      this.pending.delete(key);
      deleted += 1;
    }
    return deleted;
  }

  private keyFor(platform: ChannelPlatform, clientName: string, chatId: string): string {
    return `${platform}:${clientName}:${chatId}`;
  }

  private warn(message: string, detail?: Record<string, unknown>): void {
    if (this.options.logWarn) this.options.logWarn(message, detail);
    else logger.warn({ ...(detail ?? {}), operation: 'channel_permission_bridge' }, message);
  }
}

function bindingToContext(binding: LocalChannelBinding): LocalChannelContext {
  return {
    platform: binding.platform,
    chatType: 'p2p',
    chatId: binding.chatId,
    senderId: binding.senderId,
    clientName: binding.clientName,
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    ...(binding.lane ? { lane: binding.lane } : {}),
  };
}
