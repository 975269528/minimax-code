import { join } from 'node:path';

import { LocalChannelRouteStore, type ChannelPlatform, type SessionStrategy } from './route-api.js';
import { json, notFound, readJsonBody } from '../api/http-helpers.js';
import { LocalAgentContractError } from '../agent/contract.js';
import type { LocalChannelRunner } from './runner.js';
import type { LocalEnqueueOptions } from '../messages/queue.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type { LocalSessionProjectIdentity } from '../agent/runtime-port.js';
import type { LocalFeishuChannelApi } from './feishu.js';
import type { LocalTelegramChannelApi } from './telegram.js';
import type { LocalWeChatChannelApi } from './wechat.js';
import type {
  LocalMessageAttachment,
  LocalMessageChannelContext,
  LocalMessageQuotedMessage,
} from '../messages/input.js';
import type { LocalChannelOwnerStore } from './owner-store.js';
import { checkChannelAccess, isP2pChat, type ChannelAccessDecision } from './access.js';
import { LocalChannelAdapterRegistry } from './adapter-registry.js';
import {
  LocalAccessControlStore,
  buildAccessControlKey,
  type AccessControlDenyReason,
} from './access-control-store.js';
import { routeLocalAccessControlApi } from './access-control-routes.js';
import {
  buildAgentChannelConfig,
  buildAgentChannelConfigForAgents,
} from './agent-channel-config.js';
import { routeLocalChannelBindApi } from './channel-bind-routes.js';
import { routeChannelBindingTarget } from './channel-binding-target-route.js';
import { LocalChannelLaneQueue } from './channel-lane-queue.js';
import {
  advanceProjectMainBindings,
  attachProjectMainBinding,
} from './channel-binding-project-main.js';
import { normalizePrimaryAgentResolutionConflict } from '../api/host-channel-family-gate.js';
import {
  bindAgentDefaultChannelBinding,
  deleteAgentPlatformChannelBindings,
} from './default-channel-binding.js';
import { dispatchTelegramAdapterRoute } from './adapters/telegram/telegram-adapter-routes.js';
import { dispatchWeChatAdapterRoute } from './adapters/wechat/wechat-adapter-routes.js';
import {
  buildLocalChannelInboundRequestId,
  buildLocalChannelInboundRequestKey,
  hashLocalChannelRequestId,
  buildLocalChannelBindingKey,
  parseLocalChannelSlashCommand,
  readChannelContext,
  LOCAL_CHANNEL_SLASH_COMMANDS,
} from './channel-inbound-utils.js';
import { normalizeLocalInboundAttachments } from './inbound-media-normalizer.js';
import { reportChannelResourceAmbiguity } from './channel-resource-ambiguity.js';
import type { CompactionOutcome } from '../api/routes/compaction.js';
import { imLogger as logger } from '../common/im-logger.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import { channelRoutingModeForStrategy, type ChannelRoutingMode } from '@mavis/shared';
import { mutateDurableYaml, readYamlDocument } from './durable-yaml.js';
import {
  defaultChannelMessageFilter,
  channelBindingProjectConflicts,
  hasMultiProjectChannelBindingProfile,
  mergeChannelBindingsIntoDocument,
  normalizeChannelBinding,
  normalizeChannelMessageFilter,
  serializeChannelBinding,
  validChannelBindingRawKeys,
} from './channel-binding-codec.js';
import {
  LocalChannelRootlessError,
  RootlessChannelRouteCoordinator,
  multiProjectBindingError,
} from './rootless-route-resolver.js';
import { LocalImConnectionStore } from './im-connection-store.js';
import { LocalChannelRouteResolver } from './channel-route-resolver.js';
import {
  channelImNewCreatedReceiptText,
  channelRouteBrokenReceiptText,
  imReceiptForRoute,
  imReceiptFromRouteError,
  isMissingEnqueueSessionError,
  keepImReceiptInternal,
  logImReceipt,
} from './channel-im-receipts.js';
import type { LocalChannelImReceipt, LocalImRouteMetadata } from './channel-im-receipts.js';
import { type ChannelAgentReadScopeResolver } from './agent-owner-compatibility.js';
import { validateImBindingTargetSession } from './im-binding-target-validation.js';

export { LocalChannelRootlessError } from './rootless-route-resolver.js';
export { LocalChannelLaneQueue } from './channel-lane-queue.js';
export { LocalChannelRouteResolver } from './channel-route-resolver.js';
export {
  channelImNewCreatedReceiptText,
  channelRouteBrokenReceiptText,
} from './channel-im-receipts.js';
export type { LocalChannelImReceipt, LocalImRouteMetadata } from './channel-im-receipts.js';

export type LocalChannelLaneName = 'interactive' | 'control' | 'proactive' | string;

export interface LocalChannelContext {
  platform: ChannelPlatform;
  chatType: string;
  chatId: string;
  senderId: string;
  clientName: string;
  /**
   * Thread/topic ID (Feishu `thread_id`, Slack `thread_ts`, etc.). Present
   * ONLY when the inbound message actually lives inside a thread/topic — a
   * plain quoted reply (Feishu `parent_id` without a thread) does NOT set it.
   * Outbound adapters use this to route the reply back into the same thread
   * instead of the top-level conversation.
   */
  threadId?: string;
  /**
   * Platform message ID of the inbound message that triggered this turn.
   * Thread-aware outbound (e.g. Feishu `reply` + `reply_in_thread`) needs a
   * concrete message ID inside the thread to anchor the reply. Best-effort:
   * absent when the ctx is reconstructed without the original message id.
   */
  sourceMessageId?: string;
  /** iLink reply context token carried by WeChat inbound messages. */
  contextToken?: string;
  lane?: LocalChannelLaneName;
  hasMention?: boolean;
  /** Feishu group message contains a platform-level @all mention. */
  mentionAll?: boolean;
}

export interface LocalChannelBinding {
  key: string;
  platform: ChannelPlatform;
  clientName: string;
  chatId: string;
  senderId: string;
  threadId: string;
  lane: LocalChannelLaneName;
  agentName: string;
  sessionId: string;
  strategy: SessionStrategy;
  pinned: boolean;
  routeRuleId?: string | null;
  createdAt: number;
  updatedAt: number;
  /** Additive v2 owner, Project, intent and CAS fields. */
  exactOwnerName: string;
  ownerInstanceId?: string;
  projectKey: string;
  routingMode: ChannelRoutingMode;
  generation: number;
}

export interface LocalChannelMessageFilter {
  mode: 'result' | 'full';
  includeToolSummary: boolean;
}

export interface LocalChannelBindingWrite {
  agentName: string;
  sessionId: string;
  strategy: SessionStrategy;
  pinned?: boolean;
  routeRuleId?: string | null;
  exactOwnerName?: string;
  ownerInstanceId?: string;
  projectKey?: string;
  routingMode?: ChannelRoutingMode;
}

export interface LocalChannelResolvedRoute {
  blocked: boolean;
  agentName: string;
  sessionId?: string;
  strategy: SessionStrategy;
  ruleId: string | null;
  sessionTitle: string;
  binding?: LocalChannelBinding;
  /** Present only for the V2 Connection -> Binding route. */
  imRoute?: LocalImRouteMetadata;
}

export type LocalChannelRoutePreview = ReturnType<LocalChannelRouteStore['resolvePreview']> & {
  ownerDefaultApplied?: boolean;
};

export interface LocalChannelInboundResult {
  handled: boolean;
  command?: LocalChannelSlashCommandName;
  reply?: string;
  route?: LocalChannelResolvedRoute;
  sessionId?: string;
  queueItemId?: string;
  /** Snapshot of active/queued work ahead at the owner enqueue boundary. */
  queueAhead?: number;
  lane: LocalChannelLaneName;
  /**
   * Set to true when the inbound event was suppressed by the dedup cache
   * inside `checkChannelAccess`. The HTTP layer turns this into the runner's
   * `deduplicated` flag so callers can distinguish a 200 dedup from a real
   * 200 inbound.
   */
  deduplicated?: boolean;
  /**
   * Optional human-readable reason returned when the inbound was rejected by
   * the owner gate or hard-blocked because it is a non-p2p message. Exposed
   * to IM clients as a private `reply` so the sender understands why their
   * message was dropped.
   */
  accessDeniedReason?: string;
  /** Enables the runner to log the actual delivery result for a V2 IM receipt. */
  imReceipt?: LocalChannelImReceipt;
}

/**
 * One-shot access decision shared by transports that need to gate side effects
 * before entering the runner (Feishu WS reactions/cards are one example).
 * The token is intentionally tied to the exact normalized input so a caller
 * cannot reuse it for another message or after changing the payload.
 */
export interface LocalChannelPreflightToken {
  readonly ctx: LocalChannelContext;
  readonly text: string;
  readonly eventId?: string;
  readonly lane: LocalChannelLaneName;
}

export type LocalChannelPreflightResult =
  | { allowed: true; token: LocalChannelPreflightToken }
  | { allowed: false; inbound: LocalChannelInboundResult };

export interface LocalChannelEnqueueReceipt {
  itemId: string;
  ahead?: number;
  position?: number;
}

export interface LocalChannelEnqueueMessage {
  content: string;
  attachments?: LocalMessageAttachment[];
  quotedMessage?: LocalMessageQuotedMessage;
  channelContext?: LocalMessageChannelContext;
}

export type LocalChannelSlashCommandName = (typeof LOCAL_CHANNEL_SLASH_COMMANDS)[number];

export interface LocalChannelSlashCommand {
  name: LocalChannelSlashCommandName;
  args: string;
}

/**
 * Transport-agnostic extras threaded from {@link LocalChannelBridgeInfra.handleInbound}
 * into a slash-command handler. Today only carries the `onProgress` seam the
 * `/compact` handler uses for its two-stage progress line; keeping it a struct
 * lets future commands add per-command context without changing the registry
 * signature.
 */
export interface LocalSlashCommandExtras {
  onProgress?: (text: string) => Promise<void>;
  /** Stable inbound id used to make conversation-level `/new` replay-safe. */
  requestId?: string;
}

export class LocalChannelBindingStore {
  private bindings = new Map<string, LocalChannelBinding>();
  private messageFilters = new Map<string, LocalChannelMessageFilter>();

  constructor(
    private readonly dataDir: () => string,
    private readonly nowMs: () => number,
  ) {}

  async list(
    filter: { agentName?: string; sessionId?: string } = {},
  ): Promise<LocalChannelBinding[]> {
    await this.refresh();
    return [...this.bindings.values()]
      .filter((binding) => !filter.agentName || binding.agentName === filter.agentName)
      .filter((binding) => !filter.sessionId || binding.sessionId === filter.sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key))
      .map((binding) => ({ ...binding }));
  }

  async get(ctx: LocalChannelContext): Promise<LocalChannelBinding | undefined> {
    return this.getByKey(buildLocalChannelBindingKey(ctx));
  }

  async getByKey(key: string): Promise<LocalChannelBinding | undefined> {
    await this.refresh();
    const binding = this.bindings.get(key);
    return binding ? { ...binding } : undefined;
  }

  async assertProjectProfile(
    ctx: LocalChannelContext,
    exactOwnerName: string,
    projectKey: string,
    ownKey: string,
  ): Promise<void> {
    await this.refresh();
    if (
      channelBindingProjectConflicts(
        this.bindings.values(),
        ownKey,
        exactOwnerName,
        ctx.platform,
        ctx.clientName,
        projectKey,
      )
    ) {
      throw multiProjectBindingError();
    }
  }

  async attachProjectMain(
    ctx: LocalChannelContext,
    source: LocalChannelBinding,
    routeRuleId: string | null,
  ): Promise<LocalChannelBinding> {
    return this.mutate(() => ({
      changed: true,
      value: attachProjectMainBinding({
        bindings: this.bindings,
        ctx,
        source,
        routeRuleId,
        nowMs: this.nowMs(),
      }),
    }));
  }

  async advanceProjectMain(
    ctx: LocalChannelContext,
    source: LocalChannelBinding,
    write: Parameters<typeof advanceProjectMainBindings>[0]['write'],
  ): Promise<LocalChannelBinding> {
    return this.mutate(() => ({
      changed: true,
      value: advanceProjectMainBindings({
        bindings: this.bindings,
        ctx,
        source,
        write,
        nowMs: this.nowMs(),
      }),
    }));
  }

  async upsert(
    ctx: LocalChannelContext,
    input: LocalChannelBindingWrite,
  ): Promise<LocalChannelBinding> {
    return this.mutate(() => {
      const key = buildLocalChannelBindingKey(ctx);
      const existing = this.bindings.get(key);
      const binding = this.buildBinding(ctx, input, existing, existing?.generation ?? 0);
      this.bindings.set(key, binding);
      return { changed: true, value: { ...binding } };
    });
  }

  /** Publish one v2 binding only when the caller still owns the observed generation. */
  async compareAndSet(
    ctx: LocalChannelContext,
    input: LocalChannelBindingWrite & {
      exactOwnerName: string;
      projectKey: string;
      routingMode: ChannelRoutingMode;
      expectedGeneration: number;
    },
  ): Promise<LocalChannelBinding> {
    return this.mutate(() => {
      const key = buildLocalChannelBindingKey(ctx);
      const existing = this.bindings.get(key);
      const actualGeneration = existing?.generation ?? 0;
      if (actualGeneration !== input.expectedGeneration) {
        throw new LocalChannelRootlessError(
          409,
          'CHANNEL_BINDING_GENERATION_CONFLICT',
          'Channel binding generation changed.',
        );
      }
      if (
        channelBindingProjectConflicts(
          this.bindings.values(),
          key,
          input.exactOwnerName,
          ctx.platform,
          ctx.clientName,
          input.projectKey,
        )
      ) {
        throw multiProjectBindingError();
      }
      const binding = this.buildBinding(ctx, input, existing, actualGeneration + 1);
      this.bindings.set(key, binding);
      return { changed: true, value: { ...binding } };
    });
  }

  /**
   * Add v2 fences to the original binding file without creating a Session.
   * `resolve` may return undefined for a binding whose Agent no longer exists
   * (deterministic dead reference): that binding is kept byte-identical so
   * startup never bricks on it; inbound answers it with a receipt instead.
   */
  async migrateToV2(
    resolve: (binding: LocalChannelBinding) => Promise<
      | {
          exactOwnerName: string;
          ownerKind: 'builtin' | 'custom';
          ownerInstanceId?: string;
          projectKey: string;
        }
      | undefined
    >,
    options: {
      /** Historical rows intentionally left opaque by a local startup skip. */
      isSkipped?: (binding: LocalChannelBinding) => boolean;
    } = {},
  ): Promise<void> {
    await this.mutate(async () => {
      for (const [key, binding] of this.bindings) {
        const target = await resolve(binding);
        if (!target) continue;
        this.bindings.set(key, {
          ...binding,
          exactOwnerName: target.exactOwnerName,
          ...(target.ownerKind === 'custom' && target.ownerInstanceId
            ? { ownerInstanceId: target.ownerInstanceId }
            : { ownerInstanceId: undefined }),
          projectKey: target.projectKey,
          routingMode: channelRoutingModeForStrategy(binding.strategy),
          generation: Math.max(1, binding.generation),
        });
      }
      if (
        hasMultiProjectChannelBindingProfile(
          [...this.bindings.values()].filter((binding) => !options.isSkipped?.(binding)),
        )
      ) {
        throw multiProjectBindingError();
      }
      return { changed: true, value: undefined };
    });
  }

  async pin(
    ctx: LocalChannelContext,
    agentName: string,
    sessionId: string,
  ): Promise<LocalChannelBinding> {
    return this.upsert(ctx, {
      agentName,
      sessionId,
      strategy: 'root',
      pinned: true,
      routeRuleId: null,
    });
  }

  async pinAllForAgent(agentName: string, sessionId: string): Promise<number> {
    return this.mutate(() => {
      let count = 0;
      const now = this.nowMs();
      for (const [key, binding] of this.bindings) {
        if (binding.agentName !== agentName) continue;
        this.bindings.set(key, {
          ...binding,
          sessionId,
          strategy: 'root',
          routingMode: 'project-main',
          pinned: true,
          generation: binding.generation + 1,
          updatedAt: now,
        });
        count++;
      }
      return { changed: count > 0, value: count };
    });
  }

  /**
   * Legacy storage compatibility API. Root swaps and inbound routing never
   * call it; retained so old local integrations can still read/write files.
   */
  async migratePinnedSession(
    agentName: string,
    fromSessionId: string,
    toSessionId: string,
  ): Promise<number> {
    return this.migratePinnedSessionForAgents([agentName], fromSessionId, toSessionId);
  }

  /** Legacy family-wide storage compatibility variant; no runtime consumer. */
  async migratePinnedSessionForAgents(
    agentNames: readonly string[],
    fromSessionId: string,
    toSessionId: string,
  ): Promise<number> {
    if (fromSessionId === toSessionId) return 0;
    const names = new Set(agentNames.map((name) => name.trim()).filter(Boolean));
    if (names.size === 0) return 0;
    return this.mutate(() => {
      let count = 0;
      const now = this.nowMs();
      for (const [key, binding] of this.bindings) {
        if (!names.has(binding.agentName)) continue;
        if (binding.sessionId !== fromSessionId) continue;
        if (!binding.pinned) continue;
        this.bindings.set(key, {
          ...binding,
          sessionId: toSessionId,
          generation: binding.generation + 1,
          updatedAt: now,
        });
        count++;
      }
      return { changed: count > 0, value: count };
    });
  }

  /**
   * Move one primary-family client's bindings + message filter onto the
   * canonical client (plan §6.2). `mode: 'inspect'` reports what would happen
   * without writing, so the reconciler can refuse the whole convergence before
   * it touches any store.
   *
   * Per entry: target missing → move; target identical → dedupe the legacy
   * copy; same key with a different `sessionId` / `strategy` / `routeRuleId`
   * → conflict. Pin is opaque legacy data and does not participate in matching
   * or conflicts. Message filters key on `clientId` and follow the same rule;
   * a differing filter is a conflict rather than a silent pick of the wider one.
   */
  async rekeyPrimaryFamily(input: {
    from: { clientName: string; agentName: string };
    to: { clientName: string; agentName: string };
    mode: 'inspect' | 'apply';
  }): Promise<{ conflicts: string[]; moved: number; deduped: number }> {
    return this.mutate(() => {
      const conflicts: string[] = [];
      const moves: Array<{ fromKey: string; binding: LocalChannelBinding }> = [];
      const drops: string[] = [];
      for (const [key, binding] of this.bindings) {
        if (binding.clientName !== input.from.clientName) continue;
        const next: LocalChannelBinding = {
          ...binding,
          clientName: input.to.clientName,
          agentName: input.to.agentName,
          exactOwnerName: input.to.agentName,
          generation: binding.generation + 1,
          updatedAt: this.nowMs(),
        };
        const rekeyed: LocalChannelBinding = {
          ...next,
          key: buildLocalChannelBindingKey({
            platform: binding.platform,
            chatType: '',
            chatId: binding.chatId,
            senderId: binding.senderId,
            clientName: input.to.clientName,
            ...(binding.threadId ? { threadId: binding.threadId } : {}),
            lane: binding.lane,
          }),
        };
        const existing = this.bindings.get(rekeyed.key);
        if (!existing) {
          moves.push({ fromKey: key, binding: rekeyed });
          continue;
        }
        if (
          existing.sessionId === binding.sessionId &&
          existing.strategy === binding.strategy &&
          (existing.routeRuleId ?? null) === (binding.routeRuleId ?? null)
        ) {
          drops.push(key);
          continue;
        }
        conflicts.push(`channel_binding:${rekeyed.key}`);
      }
      const legacyFilter = this.messageFilters.get(input.from.clientName);
      const canonicalFilter = this.messageFilters.get(input.to.clientName);
      let filterAction: 'none' | 'move' | 'drop' = 'none';
      if (legacyFilter && !canonicalFilter) filterAction = 'move';
      else if (legacyFilter && canonicalFilter) {
        filterAction =
          legacyFilter.mode === canonicalFilter.mode &&
          legacyFilter.includeToolSummary === canonicalFilter.includeToolSummary
            ? 'drop'
            : 'none';
        if (filterAction === 'none') conflicts.push(`message_filter:${input.from.clientName}`);
      }
      const result = {
        conflicts,
        moved: moves.length + (filterAction === 'move' ? 1 : 0),
        deduped: drops.length + (filterAction === 'drop' ? 1 : 0),
      };
      if (input.mode === 'inspect' || conflicts.length > 0) {
        return { changed: false, value: result };
      }
      for (const move of moves) {
        this.bindings.delete(move.fromKey);
        this.bindings.set(move.binding.key, move.binding);
      }
      for (const key of drops) this.bindings.delete(key);
      if (filterAction === 'move' && legacyFilter) {
        this.messageFilters.set(input.to.clientName, legacyFilter);
      }
      if (filterAction !== 'none') this.messageFilters.delete(input.from.clientName);
      return { changed: result.moved > 0 || result.deduped > 0, value: result };
    });
  }

  async deleteByKey(key: string): Promise<boolean> {
    return this.mutate(() => {
      const deleted = this.bindings.delete(key);
      return { changed: deleted, value: deleted };
    });
  }

  async deleteByAgent(agentName: string): Promise<number> {
    return this.deleteWhere((binding) => binding.agentName === agentName);
  }

  /**
   * Platform-scoped variant of {@link deleteByAgent}.
   *
   * An unbind is always platform-scoped: unbinding one agent's Feishu app must
   * not drop the Telegram and WeChat bindings of the SAME agent, which the
   * agentName-only delete would do. Callers cleaning up after one platform's
   * unbind must use this.
   */
  async deleteByAgentPlatform(agentName: string, platform: ChannelPlatform): Promise<number> {
    return this.deleteWhere(
      (binding) => binding.agentName === agentName && binding.platform === platform,
    );
  }

  async deleteBySession(sessionId: string): Promise<number> {
    return this.deleteWhere((binding) => binding.sessionId === sessionId);
  }

  async getMessageFilter(clientId: string): Promise<LocalChannelMessageFilter> {
    await this.refresh();
    return this.messageFilters.get(clientId) ?? defaultChannelMessageFilter();
  }

  async setMessageFilter(
    clientId: string,
    filter: LocalChannelMessageFilter,
  ): Promise<LocalChannelMessageFilter> {
    const next: LocalChannelMessageFilter = {
      mode: filter.mode === 'full' ? 'full' : 'result',
      includeToolSummary: filter.includeToolSummary === true,
    };
    return this.mutate(() => {
      this.messageFilters.set(clientId, next);
      return { changed: true, value: next };
    });
  }

  private async refresh(): Promise<void> {
    this.hydrate(await readYamlDocument(this.filePath));
  }

  private hydrate(document: Record<string, unknown>): void {
    this.bindings = new Map();
    this.messageFilters = new Map();
    const bindings = document.bindings;
    if (bindings && typeof bindings === 'object') {
      for (const [key, value] of Object.entries(bindings)) {
        const binding = normalizeChannelBinding(key, value, this.nowMs());
        if (binding) this.bindings.set(binding.key, binding);
      }
    }
    const filters = document.messageFilters;
    if (filters && typeof filters === 'object') {
      for (const [clientId, value] of Object.entries(filters)) {
        const filter = normalizeChannelMessageFilter(value);
        if (filter) this.messageFilters.set(clientId, filter);
      }
    }
  }

  private async mutate<T>(
    operation: () => { changed: boolean; value: T } | Promise<{ changed: boolean; value: T }>,
  ): Promise<T> {
    return mutateDurableYaml(this.filePath, async (document) => {
      const priorKeys = validChannelBindingRawKeys(document, this.nowMs());
      this.hydrate(document);
      const result = await operation();
      if (result.changed) {
        mergeChannelBindingsIntoDocument(document, this.bindings, this.messageFilters, priorKeys);
      }
      return result;
    });
  }

  private deleteWhere(predicate: (binding: LocalChannelBinding) => boolean): Promise<number> {
    return this.mutate(() => {
      let count = 0;
      for (const [key, binding] of this.bindings) {
        if (!predicate(binding)) continue;
        this.bindings.delete(key);
        count++;
      }
      return { changed: count > 0, value: count };
    });
  }

  private buildBinding(
    ctx: LocalChannelContext,
    input: LocalChannelBindingWrite,
    existing: LocalChannelBinding | undefined,
    generation: number,
  ): LocalChannelBinding {
    const now = this.nowMs();
    return {
      key: buildLocalChannelBindingKey(ctx),
      platform: ctx.platform,
      clientName: ctx.clientName,
      chatId: ctx.chatId,
      senderId: ctx.senderId,
      threadId: ctx.threadId ?? '',
      lane: ctx.lane ?? 'interactive',
      agentName: input.agentName,
      sessionId: input.sessionId,
      strategy: input.strategy,
      pinned: input.pinned ?? existing?.pinned ?? false,
      routeRuleId: input.routeRuleId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      exactOwnerName: input.exactOwnerName ?? input.agentName,
      ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
      projectKey: input.projectKey ?? existing?.projectKey ?? 'default',
      routingMode: input.routingMode ?? channelRoutingModeForStrategy(input.strategy),
      generation,
    };
  }

  private get filePath(): string {
    return join(this.dataDir(), 'channel-bindings.yaml');
  }
}

export interface LocalChannelBridgeInfraOptions {
  dataDir: () => string;
  defaultAgentName: string;
  /** Shared read-scope seam for channel config/list filters. */
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
  /** Shared write-target seam for bind/onboard external AgentName ingress. */
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  nowMs: () => number;
  resolveDefaultWorkspaceDir: () => string;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  listSessions: (
    agentName?: string,
    options?: { includeHidden?: boolean; includePurposePrefix?: string },
  ) => Promise<LocalSessionRecord[]>;
  createSession: (input: {
    agentName?: string;
    workspaceDir: string;
    sessionType?: 'root' | 'branch';
    sessionKind?: 'conversation' | 'channel';
    title?: string | null;
    parentSessionId?: string | null;
    visibility?: 'visible' | 'hidden';
    purpose?: string;
    isDefaultWorkspace?: boolean;
  }) => Promise<LocalSessionRecord>;
  /** V2-only narrow visibility repair for an already adopted legacy IM Root. */
  revealMigratedSession?: (sessionId: string) => Promise<void>;
  createRootSession?: (agentName: string) => Promise<LocalSessionRecord | undefined>;
  /** Phase-2 Rootless routing capability. Omitted by standalone V1 compatibility hosts. */
  rootlessV2?: {
    getAgentOwnerIdentity(requestRef: string): Promise<{
      exactOwnerName: string;
      ownerKind: 'builtin' | 'custom';
      ownerInstanceId?: string;
    }>;
    getSessionAgentRoutingSnapshot(sessionId: string): Promise<
      | {
          exactOwnerName: string;
          ownerInstanceId?: string;
        }
      | undefined
    >;
    getSessionProjectIdentity(sessionId: string): Promise<LocalSessionProjectIdentity | undefined>;
    resolveProjectWorkspace(projectKey: string): {
      workspaceDir: string;
      isDefaultWorkspace: boolean;
    };
  };
  /**
   * Enables the Connection -> Binding model for the V2
   * production composition. Direct unit harnesses retain legacy rootless
   * behavior unless they explicitly opt in; retained legacy YAML is only
   * startup-transfer evidence and is never an online fallback.
   */
  imConversationModel?: boolean;
  enqueueMessage: (
    session: { sessionId: string; agentName: string },
    body: LocalChannelEnqueueMessage,
    options?: LocalEnqueueOptions,
  ) => Promise<LocalChannelEnqueueReceipt | undefined>;
  abortSession: (sessionId: string) => void | Promise<void>;
  emitBusEvent?: (type: string, payload: Record<string, unknown>) => void;
  metrics?: ModuleMetricsReporter;
  /**
   * Optional manual-compaction seam. Wired by the host to the shared
   * `runLocalCompaction` core (same core the HTTP `request-compaction` route
   * uses) so the `/compact` slash command drives compaction without going
   * through HTTP. Returns a structured {@link CompactionOutcome} (never an HTTP
   * `Response`). `onStarted` fires once the runtime + busy/lock guards pass and
   * a compaction is genuinely about to run — the channel handler uses it to
   * deliver the two-stage "started" progress line. When omitted, the `/compact`
   * handler returns a defensive "unsupported" reply.
   */
  requestCompaction?: (input: {
    sessionId: string;
    agentName: string;
    customInstructions?: string;
    reason?: string;
    onStarted?: () => Promise<void>;
  }) => Promise<CompactionOutcome>;
  /**
   * Optional owner store for the per-client owner gate (D2 + D4). When
   * provided, `checkChannelAccess` uses it to claim / verify ownership
   * before letting an inbound through.
   */
  ownerStore?: LocalChannelOwnerStore;
  /**
   * Predicate deciding whether a platform requires the owner gate. The
   * local-runtime default is `(p) => p !== 'wechat'` (WeChat iLink Bot is
   * p2p-only and uses a different token boundary). Override only when the
   * host wires a stricter / more permissive policy.
   */
  requiresOwnerGate?: (platform: ChannelPlatform) => boolean;
  /**
   * Optional shared dedup cache. When omitted, `LocalChannelBridgeInfra`
   * owns an instance-scoped cache. Exposed mainly for tests so the
   * runner can assert on cached keys without poking into private state.
   */
  eventDedupCache?: Map<string, number>;
  /**
   * Optional pre-populated adapter registry (MR-B). When omitted the infra
   * owns an empty {@link LocalChannelAdapterRegistry}; the host wire layer
   * (`host-channels.ts`) populates it after construction. The registry is
   * the only path the new `/channel-bridge/telegram/inbound|status` routes
   * use to reach a platform adapter — adapters never self-register from
   * inside `channels/`.
   */
  adapterRegistry?: LocalChannelAdapterRegistry;
  /**
   * Optional Access Control store. When provided, `handleInbound`
   * runs the policy gates before the legacy dedup + owner-gate path
   * and short-circuits on deny with `accessDeniedReason:
   * access-control:<reason>`. Also used by the CRUD routes under
   * `/mavis/api/channel-bridge/access-control/*`.
   *
   * Source of truth: knowledge/proposals/dev-im-access-control-yaml-migration.md
   * §"Integration points" 1-4.
   */
  accessControlStore?: LocalAccessControlStore;
  /**
   * Optional outbound client used to deliver a human-readable deny
   * notice back to the sender. When the AC gate denies, the infra
   * looks up a client for `ctx.platform` / `ctx.clientName` and asks
   * it to send a one-liner. P2p deny → reply directly. Group deny →
   * reply only when `ctx.hasMention === true` (avoid bot spam in
   * unrelated group traffic). The call is best-effort: a failure here
   * is swallowed so the deny itself is never blocked by outbound IO.
   */
  accessControlDenyReply?: (input: {
    ctx: LocalChannelContext;
    reason: AccessControlDenyReason;
    key: string;
  }) => Promise<'sent' | 'suppressed' | 'unavailable'>;
}

export class LocalChannelBridgeInfra {
  readonly bindingStore: LocalChannelBindingStore;
  /** V2-only durable Connection / physical Binding store. */
  readonly imConnectionStore: LocalImConnectionStore | undefined;
  readonly routeResolver: LocalChannelRouteResolver;
  readonly laneQueue = new LocalChannelLaneQueue();
  /**
   * Inbound event dedup cache keyed by `${platform}:${clientName}:${eventId}`.
   * Owned by the infra instance so HTTP / SDK callers share the same view.
   * See `channels/access.ts` for the dedup policy.
   */
  readonly eventDedupCache: Map<string, number>;
  /**
   * Unified platform-adapter registry (MR-B/C/D). The infra owns the field
   * but the host wire layer (`host-channels.ts`) populates it — `channels/`
   * never self-registers. Routes that go through this registry (today:
   * `/channel-bridge/telegram/inbound|status|bind|unbind` and
   * `/channel-bridge/feishu/card-action`) call adapter methods directly;
   * legacy routes that pre-date the registry continue to route via
   * `LocalTelegramChannelApi` / `LocalFeishuChannelApi` / etc. Defaults to a
   * fresh empty registry when `options.adapterRegistry` is omitted.
   */
  readonly adapterRegistry: LocalChannelAdapterRegistry;
  readonly rootlessEnabled: boolean;
  /**
   * Optional Access Control store. Exposed as a public field so the
   * `/mavis/api/channel-bridge/access-control/*` CRUD routes (and the
   * bind-restore flow's `ensureDefaultPolicy` call) can reach the same
   * store that `handleInbound` evaluates against.
   */
  readonly accessControlStore?: LocalAccessControlStore;
  private readonly issuedPreflightTokens = new WeakSet<LocalChannelPreflightToken>();
  /**
   * Setter for the deny-reply provider. The wire layer
   * (`host-channels.ts`) injects this AFTER the channel runner's
   * outbound-client registry is constructed, since the provider
   * needs `runner.clients.get(ctx)` to deliver the notice. Mutable so
   * the wire layer can patch it in at the right point in the
   * construction sequence without forcing the infra to depend on the
   * runner type.
   */
  accessControlDenyReply:
    | ((input: {
        ctx: LocalChannelContext;
        reason: AccessControlDenyReason;
        key: string;
      }) => Promise<'sent' | 'suppressed' | 'unavailable'>)
    | undefined;
  /**
   * Optional handler for the `POST /channel-bridge/feishu/card-action`
   * webhook. Wired by the host (host-channels.ts) to bridge a Feishu card
   * action into the {@link LocalChannelQuestionnaireBridge}. When unset, the
   * route returns 503 so an operator notices the wiring gap.
   */
  feishuCardActionHandler: ((body: Record<string, unknown>) => Promise<Response>) | undefined;

  constructor(private readonly options: LocalChannelBridgeInfraOptions) {
    this.bindingStore = new LocalChannelBindingStore(options.dataDir, options.nowMs);
    this.imConnectionStore =
      options.rootlessV2 && options.imConversationModel
        ? new LocalImConnectionStore({
            dataDir: options.dataDir,
            nowMs: options.nowMs,
            resolveProjectWorkspace: options.rootlessV2.resolveProjectWorkspace,
            createSession: options.createSession,
            validateTargetSession: (target) => validateImBindingTargetSession(options, target),
            ...(options.revealMigratedSession
              ? { revealMigratedSession: options.revealMigratedSession }
              : {}),
          })
        : undefined;
    this.routeResolver = new LocalChannelRouteResolver(
      this.bindingStore,
      options,
      this.imConnectionStore,
    );
    this.eventDedupCache = options.eventDedupCache ?? new Map<string, number>();
    this.adapterRegistry = options.adapterRegistry ?? new LocalChannelAdapterRegistry();
    this.accessControlStore = options.accessControlStore;
    this.accessControlDenyReply = options.accessControlDenyReply;
    this.rootlessEnabled = Boolean(options.rootlessV2);
  }

  /** Exposes the host-owned resolver to the shared bind route only. */
  get resolveAgentWriteTarget(): ((requestedName: string) => Promise<string>) | undefined {
    return this.options.resolveAgentWriteTarget;
  }

  get resolveAgentReadScope(): ChannelAgentReadScopeResolver | undefined {
    return this.options.resolveAgentReadScope;
  }

  /** Emit one bounded resource-ambiguity observation for an HTTP bridge request. */
  reportResourceAmbiguity(memberCount: number): void {
    reportChannelResourceAmbiguity(this.options, memberCount);
  }

  /**
   * Run the same inbound access pipeline as `handleInbound`, without routing,
   * queueing, attachment normalization, or any Agent work. The returned token
   * is consumed once by `handleInbound` so the gate is not evaluated twice.
   */
  async preflightInbound(input: {
    ctx: LocalChannelContext;
    text: string;
    eventId?: string;
  }): Promise<LocalChannelPreflightResult> {
    const command = parseLocalChannelSlashCommand(input.text);
    const lane = input.ctx.lane ?? (command ? 'control' : 'interactive');
    const didRunAccessControl = Boolean(this.options.accessControlStore);
    if (didRunAccessControl) {
      const dedup = await checkChannelAccess(input.ctx, input.eventId, this.eventDedupCache, {
        skipGroupHardBlock: true,
        skipOwnerGate: true,
      });
      if (dedup !== 'allow') return { allowed: false, inbound: mapAccessDenial(dedup, lane) };
    }
    if (this.options.accessControlStore) {
      const acStore = this.options.accessControlStore;
      const acPolicy = await acStore.get(input.ctx.platform, input.ctx.clientName);
      if (
        acPolicy.allowedUsers !== 'ALL' &&
        this.options.ownerStore &&
        isP2pChat(input.ctx.chatType)
      ) {
        await this.options.ownerStore.checkAndBootstrap(
          input.ctx.clientName,
          input.ctx.senderId,
          undefined,
        );
      }
      const decision = await acStore.evaluate({
        ctx: input.ctx,
        resolveOwnerSenderId: async (clientName) => {
          if (!this.options.ownerStore) return undefined;
          const owner = await this.options.ownerStore.getOwner(clientName);
          return owner?.ownerSenderId;
        },
      });
      if (decision.decision !== 'allow') {
        const reason: AccessControlDenyReason = decision.reason ?? 'owner_only';
        const key = buildAccessControlKey(input.ctx.platform, input.ctx.clientName);
        if (this.accessControlDenyReply) {
          try {
            const replyStatus = await this.accessControlDenyReply({
              ctx: input.ctx,
              reason,
              key,
            });
            acStore.logDenyReply({
              ctx: input.ctx,
              reason,
              key,
              status: replyStatus,
            });
          } catch {
            acStore.logDenyReply({ ctx: input.ctx, reason, key, status: 'error' });
          }
        } else {
          acStore.logDenyReply({ ctx: input.ctx, reason, key, status: 'unavailable' });
        }
        return {
          allowed: false,
          inbound: {
            handled: true,
            lane,
            accessDeniedReason: `access-control:${reason}`,
          },
        };
      }
    }
    const access = await checkChannelAccess(input.ctx, input.eventId, this.eventDedupCache, {
      ...(this.options.ownerStore ? { ownerStore: this.options.ownerStore } : {}),
      ...(this.options.requiresOwnerGate
        ? { requiresOwnerGate: this.options.requiresOwnerGate }
        : {}),
      ...(this.options.accessControlStore
        ? { skipDedupCheck: true, skipGroupHardBlock: true, skipOwnerGate: true }
        : {}),
    });
    if (access !== 'allow') return { allowed: false, inbound: mapAccessDenial(access, lane) };
    const token: LocalChannelPreflightToken = {
      ctx: input.ctx,
      text: input.text,
      ...(input.eventId ? { eventId: input.eventId } : {}),
      lane,
    };
    this.issuedPreflightTokens.add(token);
    return {
      allowed: true,
      token,
    };
  }

  async handleInbound(input: {
    ctx: LocalChannelContext;
    text: string;
    attachments?: LocalMessageAttachment[];
    quotedMessage?: LocalMessageQuotedMessage;
    /**
     * Optional platform-specific event id (Telegram `update_id`, Feishu
     * `event_id`/`message_id`, WeChat `message_id`). Used by `checkChannelAccess`
     * to dedup replays via the `${platform}:${clientName}:${eventId}` cache.
     */
    eventId?: string;
    preflight?: LocalChannelPreflightToken;
    /**
     * Optional transport-agnostic progress seam. The channel runner injects a
     * closure backed by its `deliverOutbound` so a slash command handler can
     * emit an interim message (e.g. `/compact`'s "started" line) before its
     * terminal `reply`. The infra stays transport-agnostic: it only forwards
     * the closure to the slash registry via `extras`.
     */
    onProgress?: (text: string) => Promise<void>;
  }): Promise<LocalChannelInboundResult> {
    const command = parseLocalChannelSlashCommand(input.text);
    const lane = input.ctx.lane ?? (command ? 'control' : 'interactive');
    // Inbound access check (D2 + D3) runs *before* the lane queue so:
    //   - Replayed events do not occupy a queue slot.
    //   - Group messages on owner-gated platforms are dropped before the
    //     per-lane serialisation point, so a flood of group @-mentions
    //     cannot starve p2p DMs.
    //   - The owner bootstrap (async file I/O) is not serialised by the
    //     lane — different clientNames are independent.
    // SECURITY: card_action / approval endpoints must call `checkChannelAccess`
    // when wired (D5). The dedup cache is shared via `eventDedupCache` so the
    // future approval path deduplicates clicks too.
    const preflight = input.preflight;
    const preflightMatches =
      preflight &&
      preflight.ctx === input.ctx &&
      preflight.text === input.text &&
      preflight.eventId === input.eventId &&
      preflight.lane === lane &&
      this.issuedPreflightTokens.has(preflight);
    if (preflightMatches) this.issuedPreflightTokens.delete(preflight);
    else {
      const access = await this.preflightInbound({
        ctx: input.ctx,
        text: input.text,
        ...(input.eventId ? { eventId: input.eventId } : {}),
      });
      if (!access.allowed) return access.inbound;
    }
    return this.laneQueue.enqueue(lane, async () => {
      if (command)
        return this.handleSlashCommand(input.ctx, command, lane, {
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          requestId: buildLocalChannelInboundRequestId(input.ctx, input.eventId),
        });
      // Product decision 2026-09-04 (desktop and cloud agree): when the bound
      // Agent / Session behind a Channel route has been deleted or invalidated,
      // reply a human-readable localized receipt instead of letting the error
      // bubble into an HTTP 500 (webhook entries) or a silent log-only drop
      // (polling entries) — both read as a black hole to the IM user. Cloud
      // counterpart: archon_server InboundFromChannel [im-guard].
      let route: LocalChannelResolvedRoute;
      try {
        route = await this.routeResolver.resolve(input.ctx);
      } catch (err) {
        if (err instanceof LocalChannelRootlessError) {
          const requestKey = buildLocalChannelInboundRequestKey(input.ctx, input.eventId);
          const imReceipt = imReceiptFromRouteError(err, 'route_validation', requestKey);
          if (imReceipt) {
            logImReceipt(
              input.ctx,
              imReceipt,
              'receipt_generated',
              '[im-guard] IM route validation failed; generated receipt',
            );
          } else {
            logger.warn(
              {
                requestKey: buildLocalChannelInboundRequestKey(input.ctx, input.eventId),
                platform: input.ctx.platform,
                code: err.code,
                outcome: 'receipt_generated',
              },
              '[im-guard] channel route resolve failed; generated receipt',
            );
          }
          return keepImReceiptInternal({
            handled: true,
            reply: channelRouteBrokenReceiptText(input.ctx.platform, err.code),
            ...(imReceipt?.sessionId ? { sessionId: imReceipt.sessionId } : {}),
            ...(imReceipt ? { imReceipt } : {}),
            lane,
          });
        }
        throw err;
      }
      if (route.blocked || !route.sessionId) {
        return {
          handled: true,
          reply: 'Message blocked by channel route mention policy.',
          route,
          lane,
        };
      }
      const attachments = input.attachments
        ? await normalizeLocalInboundAttachments(input.attachments)
        : undefined;
      let queued;
      try {
        queued = await this.options.enqueueMessage(
          { sessionId: route.sessionId, agentName: route.agentName },
          {
            content: input.text,
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
            ...(input.quotedMessage ? { quotedMessage: input.quotedMessage } : {}),
            channelContext: {
              platform: input.ctx.platform,
              chatType: input.ctx.chatType,
              chatId: input.ctx.chatId,
              senderId: input.ctx.senderId,
              clientName: input.ctx.clientName,
              ...(input.ctx.threadId ? { threadId: input.ctx.threadId } : {}),
              ...(input.ctx.sourceMessageId ? { sourceMessageId: input.ctx.sourceMessageId } : {}),
              ...(input.ctx.contextToken ? { contextToken: input.ctx.contextToken } : {}),
            },
          },
          { source: `channel:${input.ctx.platform}` as const },
        );
      } catch (error) {
        let imReceipt: LocalChannelImReceipt | undefined;
        if (route.imRoute && isMissingEnqueueSessionError(error)) {
          const requestKey = buildLocalChannelInboundRequestKey(input.ctx, input.eventId);
          imReceipt = imReceiptForRoute(route, 'CHANNEL_IM_SESSION_DELETED', 'enqueue', requestKey);
          // The Agent may have been deleted with its Session after route
          // validation. Recheck the resolved target without creating or
          // moving a cursor: `/new` cannot repair an invalid Agent binding.
          try {
            await this.routeResolver.validateImRouteForEnqueue(route);
          } catch (revalidation) {
            const currentReceipt =
              revalidation instanceof LocalChannelRootlessError
                ? imReceiptFromRouteError(revalidation, 'enqueue', requestKey)
                : undefined;
            if (!currentReceipt) throw revalidation;
            if (
              currentReceipt.code !== 'CHANNEL_IM_AGENT_UNAVAILABLE' &&
              currentReceipt.code !== 'CHANNEL_IM_SESSION_DELETED'
            ) {
              throw revalidation;
            }
            imReceipt = currentReceipt;
          }
        }
        if (!imReceipt) throw error;
        // The cursor stays untouched. A subsequent /new is the only action
        // that may move it after this validation-to-enqueue deletion race.
        logImReceipt(
          input.ctx,
          imReceipt,
          'receipt_generated',
          '[im-guard] IM Session disappeared before enqueue; generated receipt',
        );
        return keepImReceiptInternal({
          handled: true,
          reply: channelRouteBrokenReceiptText(input.ctx.platform, imReceipt.code),
          route,
          sessionId: route.sessionId,
          imReceipt,
          lane,
        });
      }
      return {
        handled: true,
        route,
        sessionId: route.sessionId,
        ...(queued ? { queueItemId: queued.itemId } : {}),
        ...(queued?.ahead !== undefined ? { queueAhead: queued.ahead } : {}),
        lane,
      };
    });
  }

  async status(): Promise<Record<string, unknown>> {
    const bindings = await this.bindingStore.list();
    return {
      clients: {},
      queue: this.laneQueue.stats(),
      bindings: bindings.length,
      localRuntime: true,
      runner: {
        enabled: true,
        mode: 'local-runtime',
      },
    };
  }

  async buildAgentChannelConfig(agentName: string) {
    return buildAgentChannelConfig(this.bindingStore, agentName);
  }

  async routeAgentIm(
    agentName: string,
    method: string,
    compatibleNames?: readonly string[],
  ): Promise<Response> {
    if (method === 'GET') {
      const familyNames = compatibleNames?.length ? compatibleNames : undefined;
      const names = familyNames ? new Set(familyNames) : undefined;
      const bindings = names
        ? (await this.bindingStore.list()).filter((binding) => names.has(binding.agentName))
        : await this.bindingStore.list({ agentName });
      const configResult = familyNames
        ? await buildAgentChannelConfigForAgents(this.bindingStore, familyNames)
        : { config: await this.buildAgentChannelConfig(agentName), candidates: [] };
      if (configResult.candidates.length > 0) {
        reportChannelResourceAmbiguity(this.options, configResult.candidates.length);
        return json(
          {
            channel: null,
            activeBindings: bindings.map(serializeChannelBinding),
            localRuntime: true,
            code: 'AMBIGUOUS_CHANNEL_CONFIG',
            error: `Channel config for ${agentName} is ambiguous`,
            candidates: configResult.candidates,
          },
          { status: 409 },
        );
      }
      const channel = configResult.config ?? null;
      return json({
        channel,
        activeBindings: bindings.map(serializeChannelBinding),
        localRuntime: true,
      });
    }
    if (method === 'DELETE') {
      const deletedCount = await this.bindingStore.deleteByAgent(agentName);
      return json({
        ok: true,
        deleted: deletedCount > 0,
        deletedCount,
        localRuntime: true,
      });
    }
    return notFound(`/agent/${agentName}/im`);
  }

  private async handleSlashCommand(
    ctx: LocalChannelContext,
    command: LocalChannelSlashCommand,
    lane: LocalChannelLaneName,
    extras: LocalSlashCommandExtras = {},
  ): Promise<LocalChannelInboundResult> {
    // ── Single IM-channel slash command surface ──
    // Every recognized `/<cmd>` that arrives from Feishu / Telegram / WeChat
    // goes through here. Dispatch is keyed off `command.name`; the same
    // string also drives {@link LOCAL_CHANNEL_SLASH_COMMANDS} (the parser
    // allowlist) and `LocalChannelSlashCommandName` (the TS union type).
    // The type-safe `registry` below makes TypeScript refuse to compile if
    // you add a new entry to the allowlist without wiring a handler (or vice
    // versa) — there is deliberately no fallthrough path for unknown names.
    //
    // Args are intentionally NOT logged: slash-command args from IM
    // channels can contain user prompt text, which may include sensitive
    // content. We log only `argsLength` for observability.
    logger.info(
      {
        scope: 'channel.slash',
        op: 'dispatch',
        command: command.name,
        lane,
        platform: ctx.platform,
        argsLength: command.args.length,
      },
      'Channel slash command dispatching',
    );
    // Single-source dispatch: every entry in `LOCAL_CHANNEL_SLASH_COMMANDS`
    // must have exactly one handler here. The `Record<...>` key type is the
    // command-name union derived from that constant, so TypeScript refuses to
    // compile if a command is added to the source of truth without a handler
    // (or vice versa) — no more three-way manual sync of allowlist + union +
    // if-chain.
    const registry: Record<
      LocalChannelSlashCommandName,
      (
        ctx: LocalChannelContext,
        command: LocalChannelSlashCommand,
        lane: LocalChannelLaneName,
        extras: LocalSlashCommandExtras,
      ) => Promise<LocalChannelInboundResult>
    > = {
      new: (c, cmd, l, e) => this.handleNewCommand(c, cmd, l, e),
      clear: (c, cmd, l, e) => this.handleNewCommand(c, cmd, l, e),
      stop: (c, cmd, l) => this.handleStopCommand(c, cmd, l),
      compact: (c, cmd, l, e) => this.handleCompactCommand(c, cmd, l, e),
    };
    return registry[command.name](ctx, command, lane, extras);
  }

  private async handleStopCommand(
    ctx: LocalChannelContext,
    _command: LocalChannelSlashCommand,
    lane: LocalChannelLaneName,
  ): Promise<LocalChannelInboundResult> {
    // ── `/stop` handler ──
    // Reads the active binding and aborts the underlying session's in-flight
    // turn (if any). We deliberately do NOT archive the session — `stop` is
    // a "cease current generation" verb, not a "close the chat" verb; use
    // the desktop sidebar archive for the latter.
    const baseFields = {
      scope: 'channel.slash',
      op: 'stop',
      command: 'stop',
      lane,
      platform: ctx.platform,
    };
    const route = await this.routeResolver.resolveExisting(ctx);
    if (!route?.sessionId) {
      logger.warn(
        { ...baseFields, outcome: 'no_binding' },
        'Channel /stop skipped — no active binding for this sender/chat',
      );
      return { handled: true, command: 'stop', reply: 'No active session binding found.', lane };
    }
    await this.options.abortSession(route.sessionId);
    this.options.emitBusEvent?.('channel.stop_requested', {
      targetKind: 'concrete_session',
    });
    logger.info({ ...baseFields, outcome: 'ok' }, 'Channel /stop aborted active session');
    return {
      handled: true,
      command: 'stop',
      reply: `Stop requested for session: ${route.sessionId}`,
      sessionId: route.sessionId,
      lane,
    };
  }

  private async handleNewCommand(
    ctx: LocalChannelContext,
    command: LocalChannelSlashCommand,
    lane: LocalChannelLaneName,
    extras: LocalSlashCommandExtras,
  ): Promise<LocalChannelInboundResult> {
    // Standalone V1 keeps the legacy Root swap below. Production V2 returns
    // from the Rootless branch before any Root capability is touched.
    const baseFields = {
      scope: 'channel.slash',
      op: 'new',
      command: command.name,
      lane,
      platform: ctx.platform,
    };
    const startedAt = Date.now();
    if (this.options.rootlessV2) {
      const requestId = extras.requestId?.trim() || buildLocalChannelInboundRequestId(ctx);
      try {
        const route = await this.routeResolver.advance(ctx, requestId);
        if (route.blocked || !route.sessionId) {
          logger.warn(
            { ...baseFields, outcome: 'no_route', durationMs: Date.now() - startedAt },
            'Channel /new skipped because no Rootless route is active',
          );
          return { handled: true, command: command.name, reply: 'No active route.', route, lane };
        }
        const imReceipt = imReceiptForRoute(
          route,
          'CHANNEL_IM_NEW_CREATED',
          'new_receipt',
          hashLocalChannelRequestId(requestId),
        );
        logger.info(
          { ...baseFields, outcome: 'ok', durationMs: Date.now() - startedAt },
          'Channel /new advanced the concrete Session binding',
        );
        return keepImReceiptInternal({
          handled: true,
          command: command.name,
          reply: route.imRoute
            ? channelImNewCreatedReceiptText()
            : `New session created: ${route.sessionId}`,
          route,
          sessionId: route.sessionId,
          ...(imReceipt ? { imReceipt } : {}),
          lane,
        });
      } catch (error) {
        if (error instanceof LocalChannelRootlessError) {
          const imReceipt = imReceiptFromRouteError(
            error,
            'route_validation',
            hashLocalChannelRequestId(requestId),
          );
          if (imReceipt) {
            logImReceipt(
              ctx,
              imReceipt,
              'receipt_generated',
              '[im-guard] IM /new route validation failed; generated receipt',
            );
            return keepImReceiptInternal({
              handled: true,
              command: command.name,
              reply: channelRouteBrokenReceiptText(ctx.platform, error.code),
              ...(imReceipt.sessionId ? { sessionId: imReceipt.sessionId } : {}),
              imReceipt,
              lane,
            });
          }
        }
        logger.error(
          {
            ...baseFields,
            outcome: 'failed',
            code:
              error && typeof error === 'object' && 'code' in error
                ? String(error.code)
                : 'CHANNEL_NEW_FAILED',
            durationMs: Date.now() - startedAt,
          },
          'Channel /new failed to advance the concrete Session binding',
        );
        throw error;
      }
    }
    const route = await this.routeResolver.resolve(ctx);
    if (route.blocked || !route.sessionId) {
      logger.warn(
        {
          ...baseFields,
          ...(route.agentName ? { agentName: route.agentName } : {}),
          outcome: 'no_route',
          durationMs: Date.now() - startedAt,
        },
        'Channel /new skipped — route resolver returned blocked or no sessionId',
      );
      return { handled: true, command: command.name, reply: 'No active route.', route, lane };
    }
    let createdVia: 'createRootSession' | 'createSession_fallback' = 'createRootSession';
    let session: LocalSessionRecord;
    try {
      const created = this.options.createRootSession
        ? await this.options.createRootSession(route.agentName)
        : undefined;
      if (this.options.createRootSession) {
        if (!created) {
          // The host wired `createRootSession`, but the promote path bailed
          // (agent record missing, no existing root in the sessions table,
          // demote/promote failed, …). Every failure branch now emits its
          // own logger.error/warn upstream — this line records the
          // channel-level outcome so the /new operator sees a matching
          // failure without wading through the daemon log.
          logger.error(
            {
              ...baseFields,
              agentName: route.agentName,
              previousSessionId: route.sessionId,
              outcome: 'createRootSession_failed',
              durationMs: Date.now() - startedAt,
            },
            'Channel /new failed — createRootSession returned undefined',
          );
          return {
            handled: true,
            command: command.name,
            reply: 'Failed to create a new session. Please try again later.',
            route,
            lane,
          };
        }
        session = created;
      } else {
        // Defensive: host forgot to wire `createRootSession`. Fall back to a
        // plain `createSession({sessionType:'root'})` so the inbound never
        // crashes on a host misconfig. This path is only exercised by
        // some unit test doubles.
        session = await this.options.createSession({
          agentName: route.agentName,
          workspaceDir: this.options.resolveDefaultWorkspaceDir(),
          sessionType: 'root',
          title: 'Main',
          parentSessionId: null,
          isDefaultWorkspace: true,
        });
        createdVia = 'createSession_fallback';
      }
    } catch (err) {
      logger.error(
        {
          ...baseFields,
          agentName: route.agentName,
          previousSessionId: route.sessionId,
          outcome: 'create_failed',
          durationMs: Date.now() - startedAt,
          err: err instanceof Error ? err.message : String(err),
        },
        'Channel /new failed to create root session',
      );
      throw err;
    }
    // Defense in depth: `createRootSession` already asserts `sessionType='root'`
    // via `replaceRootSession`, but if any future path re-enters this handler
    // with a non-root session we fail the command rather than report a
    // successful Root swap.
    if (session.sessionType !== 'root') {
      logger.error(
        {
          ...baseFields,
          agentName: route.agentName,
          previousSessionId: route.sessionId,
          newSessionId: session.sessionId,
          sessionType: session.sessionType,
          outcome: 'promotion_failed',
          durationMs: Date.now() - startedAt,
        },
        'Channel /new received non-root session from Root creation',
      );
      return {
        handled: true,
        command: command.name,
        reply: 'Failed to promote the new session to root. Please try again later.',
        route,
        lane,
      };
    }
    logger.info(
      {
        ...baseFields,
        agentName: route.agentName,
        previousSessionId: route.sessionId,
        newSessionId: session.sessionId,
        createdVia,
        outcome: 'ok',
        durationMs: Date.now() - startedAt,
      },
      'Channel /new archived old root and created new root',
    );
    return {
      handled: true,
      command: command.name,
      reply: `New session created: ${session.sessionId}`,
      sessionId: session.sessionId,
      lane,
    };
  }

  // [Hidden this release] /btw is unsupported. The parser treats it as an ordinary LLM message,
  // and the registry has no btw entry. Retain the dormant logic. To restore it, add 'btw' back to
  // LOCAL_CHANNEL_SLASH_COMMANDS and restore the registry entry.
  // `btw: (c, cmd, l) => this.handleBtwCommand(c, cmd, l)`。
  private async handleBtwCommand(
    ctx: LocalChannelContext,
    command: LocalChannelSlashCommand,
    lane: LocalChannelLaneName,
  ): Promise<LocalChannelInboundResult> {
    const route = await this.routeResolver.resolve(ctx);
    if (route.blocked || !route.sessionId) {
      return {
        handled: true,
        // [Hidden this release] 'btw' is no longer in LocalChannelSlashCommandName (removed from the source of truth).
        // Keep the dormant handler's receipt value unchanged, using a cast to retain the literal for a future release.
        command: 'btw' as LocalChannelSlashCommandName,
        reply: 'No active route.',
        route,
        lane,
      };
    }
    const content = command.args.trim() || 'What should I know about the current context?';
    const queued = await this.options.enqueueMessage(
      { sessionId: route.sessionId, agentName: route.agentName },
      {
        content,
        channelContext: {
          platform: ctx.platform,
          chatType: ctx.chatType,
          chatId: ctx.chatId,
          senderId: ctx.senderId,
          clientName: ctx.clientName,
          ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          ...(ctx.sourceMessageId ? { sourceMessageId: ctx.sourceMessageId } : {}),
          ...(ctx.contextToken ? { contextToken: ctx.contextToken } : {}),
        },
      },
      { source: `channel:${ctx.platform}` as const },
    );
    return {
      handled: true,
      command: 'btw' as LocalChannelSlashCommandName,
      reply: `Queued BTW question for session: ${route.sessionId}`,
      route,
      sessionId: route.sessionId,
      ...(queued ? { queueItemId: queued.itemId } : {}),
      ...(queued?.ahead !== undefined ? { queueAhead: queued.ahead } : {}),
      lane,
    };
  }

  private async handleCompactCommand(
    ctx: LocalChannelContext,
    command: LocalChannelSlashCommand,
    lane: LocalChannelLaneName,
    extras: LocalSlashCommandExtras,
  ): Promise<LocalChannelInboundResult> {
    // ── `/compact` handler ──
    // Out-of-band compaction request for the active session. We do NOT
    // touch the routing table here — `/compact` runs on whichever session
    // the route resolver currently points at (typically a branch task
    // session for short-lived work, or the agent root for the main chat).
    //
    // Stages:
    //   1. resolve route (skip cleanly if blocked / unrouteable),
    //   2. defensive check: refuse to crash if host omitted
    //      `requestCompaction` (some test scaffolding + the legacy
    //      HTTP-only boot path),
    //   3. invoke the compaction core. The core itself may return
    //      `SESSION_BUSY` / `UNSUPPORTED` / `SUCCESS` etc. — we mirror
    //      the code through the localized reply copy.
    //
    // Note: `args` here are the user's `/compact <custom instructions>`
    // payload. Like the dispatcher we log `argsLength` not the contents.
    const baseFields = {
      scope: 'channel.slash',
      op: 'compact',
      command: 'compact',
      lane,
      platform: ctx.platform,
      clientName: ctx.clientName,
      chatId: ctx.chatId,
      senderId: ctx.senderId,
      argsLength: command.args.length,
    };
    const startedAt = Date.now();
    const route = await this.routeResolver.resolve(ctx);
    if (route.blocked || !route.sessionId) {
      logger.warn(
        {
          ...baseFields,
          ...(route.agentName ? { agentName: route.agentName } : {}),
          outcome: 'no_route',
          durationMs: Date.now() - startedAt,
        },
        'Channel /compact skipped — route resolver returned blocked or no sessionId',
      );
      return { handled: true, command: 'compact', reply: 'No active route.', route, lane };
    }
    const zh = channelPrefersZh(ctx.platform);
    // Defensive: host did not wire the compaction core. Never crash the inbound
    // path — surface the "unsupported" copy so the sender gets feedback.
    if (!this.options.requestCompaction) {
      logger.warn(
        {
          ...baseFields,
          agentName: route.agentName,
          sessionId: route.sessionId,
          outcome: 'unsupported',
          durationMs: Date.now() - startedAt,
        },
        'Channel /compact ignored — host did not wire requestCompaction',
      );
      return {
        handled: true,
        command: 'compact',
        reply: compactionReply('COMPACTION_UNSUPPORTED', zh),
        route,
        sessionId: route.sessionId,
        lane,
      };
    }
    const customInstructions = command.args.trim() || undefined;
    const outcome = await this.options.requestCompaction({
      sessionId: route.sessionId,
      agentName: route.agentName,
      ...(customInstructions ? { customInstructions } : {}),
      reason: 'im_request',
      // The two-stage "started" line only fires once the core has passed its
      // busy/lock guards and is genuinely about to compact. A busy session
      // returns SESSION_BUSY before this runs, so no "started" line is sent.
      onStarted: extras.onProgress
        ? async () => {
            await extras.onProgress?.(compactionStartReply(zh));
          }
        : undefined,
    });
    const isSuccess = outcome.code === 'SUCCESS';
    if (isSuccess) {
      logger.info(
        {
          ...baseFields,
          agentName: route.agentName,
          sessionId: route.sessionId,
          outcome: 'ok',
          compactionCode: outcome.code,
          durationMs: Date.now() - startedAt,
        },
        'Channel /compact completed',
      );
    } else {
      logger.warn(
        {
          ...baseFields,
          agentName: route.agentName,
          sessionId: route.sessionId,
          outcome: 'failed',
          compactionCode: outcome.code,
          durationMs: Date.now() - startedAt,
        },
        'Channel /compact did not succeed — surfacing localized reply to sender',
      );
    }
    return {
      handled: true,
      command: 'compact',
      reply: compactionReply(outcome.code, zh),
      route,
      sessionId: route.sessionId,
      lane,
    };
  }
}

export async function routeLocalChannelBridgeInfraApi(input: {
  request: Request;
  method: string;
  parts: string[];
  url: URL;
  infra: LocalChannelBridgeInfra;
  runner?: LocalChannelRunner;
  feishu?: LocalFeishuChannelApi;
  telegram?: LocalTelegramChannelApi;
  wechat?: LocalWeChatChannelApi;
}): Promise<Response> {
  const tail = input.parts.slice(1);
  const joined = tail.join('/');
  // MR-B: registry-routed `/channel-bridge/telegram/*` endpoints. The
  // dispatcher returns `undefined` when the path is not one of the
  // adapter-routed ones, so legacy branches below still run for
  // platform webhook ingress. Inbound dispatch threads the runner
  // when one is wired so the new `/telegram/inbound` endpoint exercises
  // the same `runner.dispatchInbound` flow legacy webhooks use.
  const adapterResponse = await dispatchTelegramAdapterRoute({
    method: input.method,
    path: joined,
    request: input.request,
    registry: input.infra.adapterRegistry,
    dispatcher:
      input.runner || input.infra.resolveAgentWriteTarget
        ? {
            ...(input.runner
              ? { dispatchInbound: (dispatchInput) => input.runner!.dispatchInbound(dispatchInput) }
              : {}),
            bindDefaultBinding: (platform, agentName, clientName) =>
              bindAgentDefaultChannelBinding(input.infra, platform, agentName, clientName),
            deletePlatformBindings: (platform, agentName) =>
              deleteAgentPlatformChannelBindings(input.infra, platform, agentName),
            ...(input.telegram
              ? { ensureAdapter: (agentName) => input.telegram!.ensureAdapterForAgent(agentName) }
              : {}),
            ...(input.infra.resolveAgentWriteTarget
              ? { resolveAgentWriteTarget: input.infra.resolveAgentWriteTarget }
              : {}),
          }
        : undefined,
  });
  if (adapterResponse) return adapterResponse;
  const wechatAdapterResponse = await dispatchWeChatAdapterRoute({
    method: input.method,
    path: joined,
    request: input.request,
    registry: input.infra.adapterRegistry,
    dispatcher: input.runner
      ? { dispatchInbound: (i) => input.runner!.dispatchInbound(i) }
      : undefined,
  });
  if (wechatAdapterResponse) return wechatAdapterResponse;
  if (input.method === 'GET' && joined === 'status') {
    const status = await input.infra.status();
    const statusClients =
      status.clients && typeof status.clients === 'object'
        ? (status.clients as Record<string, unknown>)
        : {};
    const feishuClients = (await input.feishu?.statusClients()) ?? {};
    const telegramClients = (await input.telegram?.statusClients()) ?? {};
    const wechatClients = (await input.wechat?.statusClients()) ?? {};
    const scope = await resolveChannelReadAgent(
      input.infra,
      input.url.searchParams.get('agent') ?? input.url.searchParams.get('agentName') ?? undefined,
    );
    const compatibleNames = scope ? new Set(scope.compatibleNames) : undefined;
    const clients = { ...statusClients, ...feishuClients, ...telegramClients, ...wechatClients };
    const filteredClients = compatibleNames
      ? Object.fromEntries(
          Object.entries(clients).filter(([, value]) => {
            if (!value || typeof value !== 'object') return false;
            const agentName = (value as { agentName?: unknown }).agentName;
            return typeof agentName === 'string' && compatibleNames.has(agentName);
          }),
        )
      : clients;
    return json({
      ...status,
      clients: filteredClients,
      ...(input.runner ? { runner: input.runner.status() } : {}),
    });
  }
  if (input.method === 'GET' && joined === 'available-apps') {
    return json({ apps: ['feishu', 'telegram', 'wechat'], localRuntime: true });
  }
  if (input.method === 'GET' && joined === 'config-check') {
    const platform = input.url.searchParams.get('platform');
    const requestedAgentName =
      input.url.searchParams.get('agent') ?? input.url.searchParams.get('agentName') ?? undefined;
    const scope = await resolveChannelReadAgent(input.infra, requestedAgentName);
    const names = scope?.compatibleNames;
    const canonicalName = scope?.canonicalName;
    let resourceAmbiguityReported = false;
    const chooseConfig = async (
      channel: 'feishu' | 'telegram' | 'wechat',
      api: LocalFeishuChannelApi | LocalTelegramChannelApi | LocalWeChatChannelApi,
    ): Promise<Record<string, unknown> | Response> => {
      const configuredResults: Record<string, unknown>[] = [];
      const candidates: Array<{ agentName: string; platform: string }> = [];
      let fallback: Record<string, unknown> | undefined;
      let canonicalResult: Record<string, unknown> | undefined;
      if (names) {
        for (const name of names) {
          const check = await api.configCheck(name);
          if (name === canonicalName) canonicalResult = { ...check, agentName: name };
          if (check.configured === true) {
            configuredResults.push({ ...check, agentName: name });
            candidates.push({ agentName: name, platform: channel });
          }
        }
      } else {
        const check = await api.configCheck(undefined);
        fallback = check;
        if (check.configured === true) configuredResults.push(check);
      }
      if (candidates.length > 1) {
        if (!resourceAmbiguityReported) {
          resourceAmbiguityReported = true;
          input.infra.reportResourceAmbiguity(candidates.length);
        }
        return json(
          {
            configured: false,
            source: null,
            hasCredentials: false,
            platform: channel,
            localRuntime: true,
            code: 'AMBIGUOUS_CHANNEL_CONFIG',
            error: `Channel config for ${channel} is ambiguous`,
            candidates,
          },
          { status: 409 },
        );
      }
      if (configuredResults.length === 1) return configuredResults[0]!;
      const result = fallback ?? canonicalResult ?? (await api.configCheck(canonicalName));
      return { ...result, ...(canonicalName ? { agentName: canonicalName } : {}) };
    };
    if (input.feishu && platform === 'feishu') {
      const result = await chooseConfig('feishu', input.feishu);
      return result instanceof Response ? result : json(result);
    }
    if (input.telegram && platform === 'telegram') {
      const result = await chooseConfig('telegram', input.telegram);
      return result instanceof Response ? result : json(result);
    }
    if (input.wechat && platform === 'wechat') {
      const result = await chooseConfig('wechat', input.wechat);
      return result instanceof Response ? result : json(result);
    }
    if (!platform && (input.feishu || input.telegram || input.wechat)) {
      const chosen = await Promise.all([
        input.feishu ? chooseConfig('feishu', input.feishu) : undefined,
        input.telegram ? chooseConfig('telegram', input.telegram) : undefined,
        input.wechat ? chooseConfig('wechat', input.wechat) : undefined,
      ]);
      const ambiguity = chosen.find((check): check is Response => check instanceof Response);
      if (ambiguity) return ambiguity;
      const checks = chosen.filter(Boolean) as Record<string, unknown>[];
      const configured = checks.some((check) => check.configured === true);
      return json({
        configured,
        source: configured ? 'local-runtime' : null,
        hasCredentials: configured,
        localRuntime: true,
        runnerEnabled: Boolean(input.runner),
        platforms: Object.fromEntries(checks.map((check) => [String(check.platform), check])),
      });
    }
    return json({
      configured: false,
      source: null,
      hasCredentials: false,
      localRuntime: true,
      runnerEnabled: Boolean(input.runner),
    });
  }
  if (input.method === 'GET' && tail[0] === 'message-filter' && tail[1]) {
    return json(await input.infra.bindingStore.getMessageFilter(tail[1]));
  }
  if (input.method === 'PUT' && tail[0] === 'message-filter' && tail[1]) {
    const body = await readJsonBody(input.request);
    return json({
      ok: true,
      saved: true,
      ...(await input.infra.bindingStore.setMessageFilter(tail[1], {
        mode: body.mode === 'full' ? 'full' : 'result',
        includeToolSummary: body.includeToolSummary === true,
      })),
    });
  }
  // Access Control CRUD lives under /channel-bridge/access-control.
  // Delegate to the dedicated routes module so the channel subsystem
  // does not bloat this 1k+ line dispatcher.
  if (tail[0] === 'access-control') {
    return (
      (await routeLocalAccessControlApi({
        request: input.request,
        method: input.method,
        parts: tail,
        store: input.infra.accessControlStore,
      })) ?? notFound(`/channel-bridge/${joined}`)
    );
  }
  const bindResponse = await routeLocalChannelBindApi({ ...input, joined });
  if (bindResponse) return bindResponse;
  if (input.method === 'POST' && joined === 'feishu/webhook') {
    if (!input.feishu) return localRunnerUnavailable();
    return input.feishu.handleEvent(input.request, true, true);
  }
  if (input.method === 'POST' && joined === 'feishu/card-action') {
    // MR-C: Feishu interactive card action callback. Decoded into a
    // ChannelQuestionnaireOptionToken + reply by the host-supplied handler
    // (which knows how to walk the questionnaire store + invoke the
    // LocalChannelQuestionnaireBridge). When unwired, return 503 so the
    // operator notices the gap rather than silently dropping clicks.
    const body = await readJsonBody(input.request);
    const handler = input.infra.feishuCardActionHandler;
    if (!handler) {
      return json(
        {
          ok: false,
          error: 'feishu card-action handler is not wired',
          code: 'FEISHU_CARD_ACTION_UNAVAILABLE',
          localRuntime: true,
        },
        { status: 503 },
      );
    }
    return handler(body);
  }
  if (input.method === 'POST' && joined === 'telegram/bind') {
    if (!input.telegram) return localRunnerUnavailable();
    return input.telegram.bind(input.request);
  }
  if (input.method === 'POST' && joined === 'telegram/unbind') {
    if (!input.telegram) return localRunnerUnavailable();
    return input.telegram.unbind(input.request);
  }
  if (input.method === 'POST' && joined === 'telegram/webhook') {
    if (!input.telegram) return localRunnerUnavailable();
    return input.telegram.handleUpdate(input.request, true, true);
  }
  if (input.method === 'GET' && joined === 'wechat/bind/status') {
    if (!input.wechat) return localRunnerUnavailable();
    return input.wechat.bindStatus(input.url);
  }
  if (input.method === 'POST' && joined === 'wechat/webhook') {
    if (!input.wechat) return localRunnerUnavailable();
    return input.wechat.handleEvent(input.request, true, true);
  }
  if (input.method === 'GET' && tail[0] === 'bindings') {
    const requestedAgentName =
      input.url.searchParams.get('agent') ?? input.url.searchParams.get('agentName') ?? undefined;
    const scope = await resolveChannelReadAgent(
      input.infra,
      requestedAgentName,
      channelPlatformFromQuery(input.url),
    );
    const sessionId = input.url.searchParams.get('sessionId') ?? undefined;
    const bindings = await input.infra.bindingStore.list({ sessionId });
    return json({
      bindings: bindings
        .filter((binding) => !scope || scope.compatibleNames.includes(binding.agentName))
        .map(serializeChannelBinding),
    });
  }
  const targetResponse = await routeChannelBindingTarget({ ...input, tail });
  if (targetResponse) return targetResponse;
  if (input.method === 'POST' && tail[0] === 'bindings') {
    const body = await readJsonBody(input.request);
    const ctx = readChannelContext(body);
    if ('error' in ctx) return ctx.error;
    const requestedAgentName = readFirstString(body, ['agentName', 'agentId', 'agent']);
    const agentName = requestedAgentName
      ? await resolveChannelWriteAgent(input.infra, requestedAgentName, ctx.ctx.platform)
      : undefined;
    const sessionId = readFirstString(body, ['sessionId', 'session_id']);
    if (!agentName || !sessionId) {
      return json({ error: 'agentName and sessionId are required' }, { status: 400 });
    }
    const binding = await input.infra.bindingStore.upsert(ctx.ctx, {
      agentName,
      sessionId,
      strategy: normalizeStrategy(readFirstString(body, ['strategy', 'sessionStrategy'])),
      pinned: body.pinned === true,
      routeRuleId: readFirstString(body, ['routeRuleId', 'ruleId']) ?? null,
    });
    return json({ binding: serializeChannelBinding(binding) }, { status: 201 });
  }
  if (input.method === 'DELETE' && tail[0] === 'bindings' && tail[1]) {
    return json({ deleted: await input.infra.bindingStore.deleteByKey(tail[1]), key: tail[1] });
  }
  if (input.method === 'GET' && joined === 'queue/status') {
    return json({
      queue: input.infra.laneQueue.stats(),
      ...(input.runner ? { runner: input.runner.status() } : {}),
      localRuntime: true,
    });
  }
  return notFound(`/channel-bridge/${joined}`);
}

async function resolveChannelReadAgent(
  infra: LocalChannelBridgeInfra,
  requestedName: string | undefined,
  platform: ChannelPlatform = 'wechat',
): Promise<
  | {
      canonicalName: string;
      compatibleNames: readonly string[];
    }
  | undefined
> {
  if (!requestedName) return undefined;
  if (!infra.resolveAgentReadScope) {
    throw new LocalAgentContractError(
      503,
      'Agent read resolver is unavailable',
      'AGENT_RESOLVER_UNAVAILABLE',
    );
  }
  let scope: Awaited<ReturnType<NonNullable<typeof infra.resolveAgentReadScope>>>;
  try {
    scope = await infra.resolveAgentReadScope(requestedName);
  } catch (err) {
    const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
      platform,
      canonicalAgentName: 'mavis',
      agentNames: ['mavis', 'main'],
    });
    if (primaryConflict) throw primaryConflict;
    throw err;
  }
  return {
    canonicalName: scope.canonicalName,
    compatibleNames: scope.compatibleNames ?? [scope.canonicalName],
  };
}

async function resolveChannelWriteAgent(
  infra: LocalChannelBridgeInfra,
  requestedName: string,
  platform: ChannelPlatform,
): Promise<string> {
  if (!infra.resolveAgentWriteTarget) {
    throw new LocalAgentContractError(
      503,
      'Agent write resolver is unavailable',
      'AGENT_RESOLVER_UNAVAILABLE',
    );
  }
  try {
    return await infra.resolveAgentWriteTarget(requestedName);
  } catch (err) {
    const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
      platform,
      canonicalAgentName: 'mavis',
      agentNames: ['mavis', 'main'],
    });
    if (primaryConflict) throw primaryConflict;
    throw err;
  }
}

function channelPlatformFromQuery(url: URL): ChannelPlatform {
  const platform = url.searchParams.get('platform');
  return platform === 'feishu' || platform === 'telegram' || platform === 'wechat'
    ? platform
    : 'wechat';
}

export {
  buildLocalChannelBindingKey,
  parseLocalChannelSlashCommand,
} from './channel-inbound-utils.js';

function normalizeStrategy(value: unknown): SessionStrategy {
  if (
    value === 'pin' ||
    value === 'root' ||
    value === 'main' ||
    value === 'per-sender' ||
    value === 'per-chat' ||
    value === 'shared-task'
  ) {
    return value;
  }
  return 'root';
}

function normalizePlatform(value: unknown): ChannelPlatform | undefined {
  return value === 'feishu' || value === 'telegram' || value === 'wechat' ? value : undefined;
}

function readFirstString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Translate a non-`allow` `checkChannelAccess` decision into the runner's
 * inbound shape. We deliberately do NOT send a chat reply on `deny`:
 *   - Group hard-block: any reply would surface inside the group, which
 *     would leak the policy to non-owner members and invite probing.
 *   - Not-owner: replying to a non-owner DMs them with policy text, which
 *     spams them and reveals that another user owns the channel.
 *   - Dedup: the user has already received a response for this event; a
 *     second reply would be a duplicate.
 * The `accessDeniedReason` field is set so internal callers (e.g. the
 * `status` endpoint or a future operator dashboard) can surface why an
 * event was dropped, without exposing it to the IM platform.
 */
function mapAccessDenial(
  access: ChannelAccessDecision,
  lane: LocalChannelLaneName,
): LocalChannelInboundResult {
  if (access === 'dedup') {
    return { handled: true, deduplicated: true, lane };
  }
  // access === 'deny' — distinguish group-block vs not-owner for diagnostics.
  // We re-derive the reason on the hot path rather than threading the full
  // `ChannelAccessDenyReason` through the access layer, because the access
  // decision itself is the only thing HTTP handlers need to react to.
  return {
    handled: true,
    lane,
    accessDeniedReason: 'not-owner-or-non-p2p',
  };
}

/**
 * Channel language convention (matches the archon-side `channelLanguage`
 * contract): Telegram replies in English, every other IM platform in Chinese.
 * Kept local to the infra so the `/compact` two-stage receipts don't pull in a
 * heavier i18n dependency for two strings.
 */
function channelPrefersZh(platform: ChannelPlatform): boolean {
  return platform !== 'telegram';
}

/** Two-stage `/compact` "started" line — sent only when a compaction genuinely begins. */
function compactionStartReply(zh: boolean): string {
  return zh ? '🔄 正在压缩上下文…' : '🔄 Compacting context…';
}

/**
 * Terminal `/compact` receipt for a given {@link CompactionOutcome} code. The
 * success line intentionally omits N→M counts (per spec §D). Unknown / hard
 * failure codes fall back to the generic "unsupported" copy so the sender is
 * never left without feedback.
 */
function compactionReply(code: string, zh: boolean): string {
  switch (code) {
    case 'OK':
      return zh ? '✨ 上下文已压缩' : '✨ Context compacted.';
    case 'NOTHING_TO_COMPACT':
      return zh ? '📭 暂无可压缩的上下文' : '📭 Nothing to compact.';
    case 'SESSION_BUSY':
      return zh
        ? '⏳ 会话正在处理中，请稍后再试（可先 /stop）'
        : '⏳ Session is busy, try again later (or /stop).';
    case 'COMPACTION_UNSUPPORTED':
    default:
      return zh ? '⚠️ 当前会话不支持压缩' : '⚠️ This session does not support compaction.';
  }
}

function localRunnerUnavailable(): Response {
  return json(
    {
      ok: false,
      error: 'Local channel platform runner is not implemented in G6 channel infra.',
      code: 'LOCAL_CHANNEL_RUNNER_UNAVAILABLE',
      localRuntime: true,
    },
    { status: 200 },
  );
}
