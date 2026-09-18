import {
  LocalChannelRouteStore,
  type ChannelRoutePreviewContext,
  type SessionStrategy,
} from './route-api.js';
import type { ChannelRoutingMode } from '@mavis/shared';
import { applyClientOwnerDefault } from './client-owner-routing.js';
import {
  buildLocalChannelInboundRequestId,
  hashLocalChannelRequestId,
} from './channel-inbound-utils.js';
import {
  LocalChannelRootlessError,
  RootlessChannelRouteCoordinator,
} from './rootless-route-resolver.js';
import {
  isCompatibleChannelAgentOwner,
  type ChannelAgentOwnerIdentity,
} from './agent-owner-compatibility.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type {
  LocalChannelBinding,
  LocalChannelBindingStore,
  LocalChannelBridgeInfraOptions,
  LocalChannelContext,
  LocalChannelResolvedRoute,
} from './infra.js';
import type { LocalImConnectionStore } from './im-connection-store.js';

/** Resolves new IM physical bindings before the one-version legacy route fallback. */
export class LocalChannelRouteResolver {
  private readonly rootless: RootlessChannelRouteCoordinator | undefined;

  constructor(
    private readonly bindingStore: LocalChannelBindingStore,
    private readonly options: LocalChannelBridgeInfraOptions,
    private readonly imConnectionStore?: LocalImConnectionStore,
  ) {
    this.rootless = options.rootlessV2
      ? new RootlessChannelRouteCoordinator(bindingStore, options)
      : undefined;
  }

  async resolve(ctx: LocalChannelContext): Promise<LocalChannelResolvedRoute> {
    return this.resolveWithLegacyFallback(ctx, false);
  }

  /**
   * Compatibility-only route creation for legacy bind endpoints that arrived
   * without `connection_id`. New IM Connection flows always use `resolve()`
   * and therefore cannot write the opaque per-chat `bindings` rows.
   */
  async resolveLegacy(ctx: LocalChannelContext): Promise<LocalChannelResolvedRoute> {
    return this.resolveWithLegacyFallback(ctx, true);
  }

  private async resolveWithLegacyFallback(
    ctx: LocalChannelContext,
    allowLegacyFallback: boolean,
  ): Promise<LocalChannelResolvedRoute> {
    const imRoute = await this.resolveImRoute(ctx);
    if (imRoute) return imRoute;
    const existing = await this.rootless?.resolveExisting(ctx);
    if (existing) return existing;
    const hasLegacyClientBinding = allowLegacyFallback || (await this.hasLegacyClientBinding(ctx));
    if (this.imConnectionStore && !hasLegacyClientBinding) {
      // In the V2 IM model, an inbound message must be explicitly associated
      // with a physical Binding. A legacy platform bind writes one opaque
      // client-default row, which is the sole compatibility proof allowed to
      // materialize later legacy chat rows. New Connection flows never write
      // that row, so they remain blocked without a physical Binding.
      return {
        blocked: true,
        agentName: '',
        strategy: 'per-chat',
        ruleId: null,
        sessionTitle: '',
      };
    }
    const routeStore = await this.loadRouteStore();
    const preview = applyClientOwnerDefault(routeStore.resolvePreview(toPreviewContext(ctx)), ctx);
    if (preview.blocked) {
      return {
        blocked: true,
        agentName: preview.agentId,
        strategy: preview.sessionStrategy as SessionStrategy,
        ruleId: preview.ruleId,
        sessionTitle: preview.sessionTitle,
      };
    }
    const strategy = normalizeStrategy(preview.sessionStrategy);
    if (this.rootless) return this.rootless.resolve(ctx, preview, strategy);
    const session = await this.resolveSession(preview.agentId, strategy, preview.sessionTitle, ctx);
    const binding = await this.bindingStore.upsert(ctx, {
      agentName: preview.agentId,
      sessionId: session.sessionId,
      strategy,
      pinned: false,
      routeRuleId: preview.ruleId,
    });
    return {
      blocked: false,
      agentName: preview.agentId,
      sessionId: session.sessionId,
      strategy,
      ruleId: preview.ruleId,
      sessionTitle: preview.sessionTitle,
      binding,
    };
  }

  private async hasLegacyClientBinding(ctx: LocalChannelContext): Promise<boolean> {
    return (await this.bindingStore.list()).some(
      (binding) => binding.platform === ctx.platform && binding.clientName === ctx.clientName,
    );
  }

  async preview(ctx: LocalChannelContext) {
    const routeStore = await this.loadRouteStore();
    return applyClientOwnerDefault(routeStore.resolvePreview(toPreviewContext(ctx)), ctx);
  }

  /** `/new` advances only this IM scope; Desktop/Task bindings are untouched. */
  async advance(ctx: LocalChannelContext, requestId?: string): Promise<LocalChannelResolvedRoute> {
    const imRoute = await this.advanceImRoute(
      ctx,
      requestId?.trim() || buildLocalChannelInboundRequestId(ctx),
    );
    if (imRoute) return imRoute;
    // Existing legacy/rootless route rows remain readable for the one-version
    // compatibility window. A V2 IM store only prevents synthesizing a *new*
    // legacy row; it must not make /new inert for a route that already exists.
    const existing = await this.rootless?.resolveExisting(ctx);
    if (existing && this.rootless) {
      const routeStore = await this.loadRouteStore();
      const preview = applyClientOwnerDefault(
        routeStore.resolvePreview(toPreviewContext(ctx)),
        ctx,
      );
      if (preview.blocked) {
        return {
          blocked: true,
          agentName: preview.agentId,
          strategy: normalizeStrategy(preview.sessionStrategy),
          ruleId: preview.ruleId,
          sessionTitle: preview.sessionTitle,
        };
      }
      const advanced = await this.rootless.advanceExisting(
        ctx,
        preview,
        normalizeStrategy(preview.sessionStrategy),
      );
      if (advanced) return advanced;
    }
    if (this.imConnectionStore) {
      return {
        blocked: true,
        agentName: '',
        strategy: 'per-chat',
        ruleId: null,
        sessionTitle: '',
      };
    }
    if (!this.rootless) return this.resolve(ctx);
    const routeStore = await this.loadRouteStore();
    const preview = applyClientOwnerDefault(routeStore.resolvePreview(toPreviewContext(ctx)), ctx);
    if (preview.blocked) {
      return {
        blocked: true,
        agentName: preview.agentId,
        strategy: normalizeStrategy(preview.sessionStrategy),
        ruleId: preview.ruleId,
        sessionTitle: preview.sessionTitle,
      };
    }
    return this.rootless.advance(ctx, preview, normalizeStrategy(preview.sessionStrategy));
  }

  /** Finds an already-bound route without creating any new legacy state. */
  async resolveExisting(ctx: LocalChannelContext): Promise<LocalChannelResolvedRoute | undefined> {
    const imRoute = await this.resolveImRoute(ctx);
    if (imRoute) return imRoute;
    const rootlessRoute = await this.rootless?.resolveExisting(ctx);
    if (rootlessRoute) return rootlessRoute;
    const binding = await this.bindingStore.get(ctx);
    if (!binding) return undefined;
    return {
      blocked: false,
      agentName: binding.agentName,
      sessionId: binding.sessionId,
      strategy: binding.strategy,
      ruleId: binding.routeRuleId ?? null,
      sessionTitle: '',
      binding,
    };
  }

  /** Rechecks an already-resolved IM target without advancing or creating a cursor. */
  async validateImRouteForEnqueue(route: LocalChannelResolvedRoute): Promise<void> {
    if (!route.imRoute) return;
    const owner = await this.requireImRouteOwner(route);
    await this.requireImRouteSession(route, owner);
  }

  async updateBindingTarget(input: {
    bindingId: string;
    agentName: string;
    projectKey: string;
    routingMode: ChannelRoutingMode;
    sessionId?: string;
    ownerInstanceId?: string;
    expectedGeneration: number;
  }): Promise<LocalChannelBinding> {
    if (!this.rootless) {
      throw new LocalChannelRootlessError(
        503,
        'ROOTLESS_CHANNEL_UNAVAILABLE',
        'Rootless Channel routing is unavailable.',
      );
    }
    return this.rootless.bindExplicit(input);
  }

  private async resolveSession(
    agentName: string,
    strategy: SessionStrategy,
    sessionTitle: string,
    ctx: LocalChannelContext,
  ): Promise<LocalSessionRecord> {
    const normalized = normalizeStrategy(strategy);
    if (normalized === 'root' || normalized === 'main') {
      const root = (await this.options.listSessions(agentName, { includeHidden: true })).find(
        (session) => session.runtime === 'pi-agent' && session.sessionType === 'root',
      );
      if (root) return root;
      return this.options.createSession({
        agentName,
        workspaceDir: this.options.resolveDefaultWorkspaceDir(),
        sessionType: 'root',
        title: 'Main',
        parentSessionId: null,
        isDefaultWorkspace: true,
      });
    }

    const purpose = buildChannelSessionPurpose(ctx, normalized, sessionTitle);
    const existing = (
      await this.options.listSessions(agentName, {
        includeHidden: true,
        includePurposePrefix: purpose,
      })
    ).find((session) => session.runtime === 'pi-agent' && session.purpose === purpose);
    if (existing) return existing;
    return this.options.createSession({
      agentName,
      workspaceDir: this.options.resolveDefaultWorkspaceDir(),
      sessionType: 'branch',
      sessionKind: 'channel',
      title: sessionTitle || buildChannelSessionTitle(ctx, normalized),
      parentSessionId: null,
      visibility: 'visible',
      purpose,
    });
  }

  private loadRouteStore(): Promise<LocalChannelRouteStore> {
    return LocalChannelRouteStore.load(
      this.options.dataDir(),
      this.options.defaultAgentName,
      this.options.nowMs,
    );
  }

  private async resolveImRoute(
    ctx: LocalChannelContext,
  ): Promise<LocalChannelResolvedRoute | undefined> {
    const store = this.imConnectionStore;
    const preview = await store?.peekRoute(ctx);
    if (!store || !preview) return undefined;
    const owner = await this.requireImRouteOwner(preview);
    // A populated cursor is read-only here: `resolveRoute` would return this
    // same physical Binding cursor. Returning the validated peek avoids a
    // second Agent-profile read on every ordinary IM message.
    if (preview.sessionId) {
      await this.requireImRouteSession(preview, owner);
      return preview;
    }

    // An empty cursor is allowed to create its first Session. Revalidate the
    // resulting physical route because either the Binding target or Agent
    // identity can change while creation is in flight.
    const route = await store.resolveRoute(ctx);
    if (!route) return undefined;
    const resolvedOwner = await this.requireImRouteOwner(route);
    await this.requireImRouteSession(route, resolvedOwner);
    return route;
  }

  private async advanceImRoute(
    ctx: LocalChannelContext,
    requestId: string,
  ): Promise<LocalChannelResolvedRoute | undefined> {
    const store = this.imConnectionStore;
    const preview = await store?.peekRoute(ctx);
    if (!store || !preview) return undefined;
    // `/new` deliberately does not require the prior cursor to exist: it is
    // the user-authorized recovery path for a deleted IM Binding Session.
    await this.requireImRouteOwner(preview);
    const route = await store.advance(ctx, requestId, {
      requestKey: hashLocalChannelRequestId(requestId),
    });
    if (!route) return undefined;
    const resolvedOwner = await this.requireImRouteOwner(route);
    await this.requireImRouteSession(route, resolvedOwner);
    return route;
  }

  private async requireImRouteOwner(
    route: LocalChannelResolvedRoute,
  ): Promise<ChannelAgentOwnerIdentity> {
    const rootless = this.options.rootlessV2;
    if (!rootless) {
      throw new LocalChannelRootlessError(
        503,
        'ROOTLESS_CHANNEL_UNAVAILABLE',
        'Rootless Channel routing is unavailable.',
      );
    }
    let owner: ChannelAgentOwnerIdentity;
    try {
      owner = await rootless.getAgentOwnerIdentity(route.agentName);
    } catch (error) {
      if (isMissingAgentError(error)) {
        throw this.imRouteError(
          route,
          'CHANNEL_IM_AGENT_UNAVAILABLE',
          'The IM Connection Agent is no longer available.',
        );
      }
      // A transient config/store failure is not evidence that the Agent was
      // deleted. Preserve it for the host's normal retry/error handling.
      throw error;
    }
    if (!(await this.imRouteAgentMatches(route.agentName, owner))) {
      throw this.imRouteError(
        route,
        'CHANNEL_IM_AGENT_UNAVAILABLE',
        'The IM Connection Agent is no longer available.',
      );
    }
    return owner;
  }

  private async requireImRouteSession(
    route: LocalChannelResolvedRoute,
    owner: ChannelAgentOwnerIdentity,
  ): Promise<void> {
    const sessionId = route.sessionId;
    const session = sessionId ? await this.options.getSessionById(sessionId) : undefined;
    if (!session) {
      throw this.imRouteError(
        route,
        'CHANNEL_IM_SESSION_DELETED',
        'The IM Binding Session no longer exists.',
      );
    }
    if (!(await this.imRouteAgentMatches(session.agentName, owner))) {
      throw this.imRouteError(
        route,
        'CHANNEL_IM_AGENT_UNAVAILABLE',
        'The IM Binding Session no longer belongs to its Agent.',
      );
    }
  }

  private imRouteAgentMatches(
    persistedAgentName: string,
    owner: ChannelAgentOwnerIdentity,
  ): Promise<boolean> {
    if (owner.ownerKind === 'custom') {
      return Promise.resolve(persistedAgentName === owner.exactOwnerName);
    }
    return isCompatibleChannelAgentOwner({
      persisted: { exactOwnerName: persistedAgentName },
      current: owner,
      ...(this.options.resolveAgentReadScope
        ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
        : {}),
    });
  }

  private imRouteError(
    route: LocalChannelResolvedRoute,
    code: string,
    message: string,
  ): LocalChannelRootlessError {
    if (!route.imRoute) return new LocalChannelRootlessError(409, code, message);
    return new LocalChannelRootlessError(409, code, message, {
      ...route.imRoute,
      ...(route.sessionId ? { sessionId: route.sessionId } : {}),
    });
  }
}

function isMissingAgentError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'AGENT_NOT_FOUND'
  );
}

function toPreviewContext(ctx: LocalChannelContext): ChannelRoutePreviewContext {
  return {
    platform: ctx.platform,
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    senderId: ctx.senderId,
    clientName: ctx.clientName,
    hasMention: ctx.hasMention === true,
  };
}

function buildChannelSessionPurpose(
  ctx: LocalChannelContext,
  strategy: SessionStrategy,
  sessionTitle: string,
): string {
  const key =
    strategy === 'per-sender'
      ? ctx.senderId
      : strategy === 'per-chat'
        ? ctx.chatId
        : sessionTitle || ctx.chatId;
  return `channel:${ctx.platform}:${strategy}:${key}`;
}

function buildChannelSessionTitle(ctx: LocalChannelContext, strategy: SessionStrategy): string {
  if (strategy === 'per-sender') return `${ctx.platform}-${ctx.senderId}`;
  if (strategy === 'per-chat') return `${ctx.platform}-chat-${ctx.chatId}`;
  return `${ctx.platform}-${ctx.chatId}`;
}

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
