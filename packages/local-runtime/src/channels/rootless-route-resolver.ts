import { KeyedOperationLane, type ChannelRoutingMode } from '@mavis/shared';

import type {
  LocalChannelBinding,
  LocalChannelBindingStore,
  LocalChannelBridgeInfraOptions,
  LocalChannelContext,
  LocalImRouteMetadata,
  LocalChannelRoutePreview,
  LocalChannelResolvedRoute,
} from './infra.js';
import type { SessionStrategy } from './route-api.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { buildLocalChannelBindingKey } from './channel-inbound-utils.js';
import {
  buildScopeKey,
  buildSessionPurpose,
  buildSessionTitle,
  contextForBinding,
  strategyForRoutingMode,
} from './rootless-route-context.js';
import {
  isCompatibleChannelAgentOwner,
  type ChannelAgentOwnerIdentity,
} from './agent-owner-compatibility.js';

export class LocalChannelRootlessError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly imRoute?: LocalImRouteMetadata & { readonly sessionId?: string },
  ) {
    super(message);
    this.name = 'LocalChannelRootlessError';
  }
}

export function multiProjectBindingError(): LocalChannelRootlessError {
  return new LocalChannelRootlessError(
    409,
    'CHANNEL_BINDING_MULTI_PROJECT',
    'One Channel binding profile cannot target multiple Projects.',
  );
}

/** Stateful only for the semantic-scope queue; persistence stays in the v1 YAML store. */
export class RootlessChannelRouteCoordinator {
  private readonly scopeLane = new KeyedOperationLane<string>();

  constructor(
    private readonly bindingStore: LocalChannelBindingStore,
    private readonly options: LocalChannelBridgeInfraOptions,
  ) {}

  async resolveExisting(ctx: LocalChannelContext): Promise<LocalChannelResolvedRoute | undefined> {
    const current = await this.bindingStore.get(ctx);
    if (!current) return undefined;
    const owner = await this.options
      .rootlessV2!.getAgentOwnerIdentity(current.agentName)
      .catch(() => undefined);
    if (
      !owner ||
      !(await isCompatibleChannelAgentOwner({
        persisted: current,
        current: owner,
        ...(this.options.resolveAgentReadScope
          ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
          : {}),
      }))
    ) {
      return undefined;
    }
    if (current.routingMode === 'project-main') {
      await this.projectMainProfile(ctx, owner, current.projectKey);
    }
    return (await this.validateBinding(current)) ? this.resolvedFromBinding(current) : undefined;
  }

  resolve(
    ctx: LocalChannelContext,
    preview: LocalChannelRoutePreview,
    strategy: SessionStrategy,
  ): Promise<LocalChannelResolvedRoute> {
    return this.scopeLane.run(buildScopeKey(preview, ctx), async () => {
      const current = await this.bindingStore.get(ctx);
      if (current && (await this.validateBinding(current))) {
        return this.resolvedFromBinding(current);
      }
      return this.publish(ctx, preview, strategy, current, false);
    });
  }

  advance(
    ctx: LocalChannelContext,
    preview: LocalChannelRoutePreview,
    strategy: SessionStrategy,
  ): Promise<LocalChannelResolvedRoute> {
    return this.advanceInternal(
      ctx,
      preview,
      strategy,
      false,
    ) as Promise<LocalChannelResolvedRoute>;
  }

  /** Advance an already-persisted compatibility route without ever creating one. */
  advanceExisting(
    ctx: LocalChannelContext,
    preview: LocalChannelRoutePreview,
    strategy: SessionStrategy,
  ): Promise<LocalChannelResolvedRoute | undefined> {
    return this.advanceInternal(ctx, preview, strategy, true);
  }

  private advanceInternal(
    ctx: LocalChannelContext,
    preview: LocalChannelRoutePreview,
    strategy: SessionStrategy,
    requireExisting: boolean,
  ): Promise<LocalChannelResolvedRoute | undefined> {
    return this.scopeLane.run(buildScopeKey(preview, ctx), async () => {
      const current = await this.bindingStore.get(ctx);
      if (!current && requireExisting) return undefined;
      if (current && !(await this.validateBinding(current))) {
        throw new LocalChannelRootlessError(
          409,
          'CHANNEL_BINDING_STALE',
          'The existing Channel binding is stale.',
        );
      }
      return this.publish(ctx, preview, strategy, current, true);
    });
  }

  async bindExplicit(input: {
    bindingId: string;
    agentName: string;
    projectKey: string;
    routingMode: ChannelRoutingMode;
    sessionId?: string;
    ownerInstanceId?: string;
    expectedGeneration: number;
  }): Promise<LocalChannelBinding> {
    const candidates = (await this.bindingStore.list()).filter(
      (binding) => binding.key === input.bindingId || binding.clientName === input.bindingId,
    );
    if (candidates.length !== 1) {
      throw new LocalChannelRootlessError(
        candidates.length === 0 ? 404 : 409,
        candidates.length === 0 ? 'CHANNEL_BINDING_NOT_FOUND' : 'CHANNEL_BINDING_AMBIGUOUS',
        'The Channel binding target cannot be resolved uniquely.',
      );
    }
    const initial = candidates[0]!;
    const ctx = contextForBinding(initial);
    const strategy = strategyForRoutingMode(input.routingMode);
    const owner = await this.options.rootlessV2!.getAgentOwnerIdentity(input.agentName);
    const preview: LocalChannelRoutePreview = {
      ruleId: initial.routeRuleId ?? null,
      agentId: owner.exactOwnerName,
      sessionStrategy: strategy,
      sessionTitle: '',
      blocked: false,
      exactOwnerName: owner.exactOwnerName,
      ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
      projectKey: input.projectKey,
      routingMode: input.routingMode,
      generation: input.expectedGeneration,
    };
    return this.scopeLane.run(buildScopeKey(preview, ctx), async () => {
      const existing = await this.bindingStore.getByKey(initial.key);
      if (!existing || existing.generation !== input.expectedGeneration) {
        throw new LocalChannelRootlessError(
          409,
          'CHANNEL_BINDING_GENERATION_CONFLICT',
          'Channel binding generation changed.',
        );
      }
      if (
        !(await isCompatibleChannelAgentOwner({
          persisted: existing,
          current: owner,
          ...(this.options.resolveAgentReadScope
            ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
            : {}),
        }))
      ) {
        throw new LocalChannelRootlessError(
          409,
          'CHANNEL_BINDING_OWNER_CHANGE_REQUIRES_REBIND',
          'Changing a physical Channel binding owner requires rebinding the client.',
        );
      }
      assertRequestedOwner(input.ownerInstanceId, owner);
      await this.bindingStore.assertProjectProfile(
        ctx,
        owner.exactOwnerName,
        input.projectKey,
        existing.key,
      );
      if (!input.sessionId) {
        const resolved = await this.publish(
          ctx,
          preview,
          strategy,
          existing,
          true,
          input.routingMode === 'project-main' && existing.routingMode === 'project-main'
            ? existing
            : undefined,
        );
        return resolved.binding!;
      }
      const session = await this.options.getSessionById(input.sessionId);
      if (!session || !(await this.validateSession(session, owner, input.projectKey))) {
        throw new LocalChannelRootlessError(
          409,
          'CHANNEL_SESSION_VALIDATION_FAILED',
          'The explicit Session does not match the Agent owner and Project.',
        );
      }
      const write = {
        agentName: owner.exactOwnerName,
        sessionId: session.sessionId,
        strategy,
        pinned: false,
        routeRuleId: existing.routeRuleId,
        exactOwnerName: owner.exactOwnerName,
        ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
        projectKey: input.projectKey,
        routingMode: input.routingMode,
        expectedGeneration: input.expectedGeneration,
      };
      return input.routingMode === 'project-main' && existing.routingMode === 'project-main'
        ? this.bindingStore.advanceProjectMain(ctx, existing, write)
        : this.bindingStore.compareAndSet(ctx, write);
    });
  }

  private async publish(
    ctx: LocalChannelContext,
    preview: LocalChannelRoutePreview,
    strategy: SessionStrategy,
    current: LocalChannelBinding | undefined,
    forceAdvance: boolean,
    profileSeedOverride?: LocalChannelBinding,
  ): Promise<LocalChannelResolvedRoute> {
    const rootless = this.options.rootlessV2!;
    const owner = await rootless.getAgentOwnerIdentity(preview.agentId);
    await assertCurrentOwner(preview, owner, this.options.resolveAgentReadScope);
    const profile =
      preview.routingMode === 'project-main'
        ? await this.projectMainProfile(ctx, owner, preview.projectKey)
        : [];
    const profileSeed = profileSeedOverride ?? profile[0];
    if (!forceAdvance && profileSeed && (await this.validateBinding(profileSeed))) {
      const binding =
        current?.key === profileSeed.key
          ? profileSeed
          : await this.bindingStore.attachProjectMain(ctx, profileSeed, preview.ruleId);
      return this.resolvedFromBinding(binding);
    }
    const expectedGeneration = profileSeed?.generation ?? current?.generation ?? 0;
    await this.bindingStore.assertProjectProfile(
      ctx,
      owner.exactOwnerName,
      preview.projectKey,
      current?.key ?? buildLocalChannelBindingKey(ctx),
    );
    const generation = expectedGeneration + 1;
    let session: LocalSessionRecord | undefined;
    if (!forceAdvance && preview.sessionId) {
      session = await this.options.getSessionById(preview.sessionId);
    }
    if (!session) {
      const purpose = buildSessionPurpose({
        ctx,
        exactOwnerName: owner.exactOwnerName,
        ownerInstanceId: owner.ownerInstanceId,
        projectKey: preview.projectKey,
        routingMode: preview.routingMode,
        generation,
        sessionTitle: preview.sessionTitle,
      });
      session = (
        await this.options.listSessions(owner.exactOwnerName, {
          includeHidden: true,
          includePurposePrefix: purpose,
        })
      ).find((candidate) => candidate.purpose === purpose);
      if (!session) {
        const workspace = rootless.resolveProjectWorkspace(preview.projectKey);
        session = await this.options.createSession({
          agentName: owner.exactOwnerName,
          workspaceDir: workspace.workspaceDir,
          isDefaultWorkspace: workspace.isDefaultWorkspace,
          sessionType: 'branch',
          sessionKind: 'channel',
          title: preview.sessionTitle || buildSessionTitle(ctx, strategy),
          parentSessionId: null,
          visibility: 'visible',
          purpose,
        });
      }
    }
    const committed = await this.options.getSessionById(session.sessionId);
    if (!committed || !(await this.validateSession(committed, owner, preview.projectKey))) {
      throw new LocalChannelRootlessError(
        409,
        'CHANNEL_SESSION_VALIDATION_FAILED',
        'The committed Channel Session failed owner or Project validation.',
      );
    }
    const write = {
      agentName: owner.exactOwnerName,
      sessionId: committed.sessionId,
      strategy,
      pinned: false,
      routeRuleId: preview.ruleId,
      exactOwnerName: owner.exactOwnerName,
      ...(owner.ownerInstanceId ? { ownerInstanceId: owner.ownerInstanceId } : {}),
      projectKey: preview.projectKey,
      routingMode: preview.routingMode,
      expectedGeneration,
    };
    const binding = profileSeed
      ? await this.bindingStore.advanceProjectMain(ctx, profileSeed, write)
      : await this.bindingStore.compareAndSet(ctx, write);
    return {
      blocked: false,
      agentName: owner.exactOwnerName,
      sessionId: committed.sessionId,
      strategy,
      ruleId: preview.ruleId,
      sessionTitle: preview.sessionTitle,
      binding,
    };
  }

  private async projectMainProfile(
    ctx: LocalChannelContext,
    owner: { exactOwnerName: string; ownerInstanceId?: string },
    projectKey: string,
  ): Promise<LocalChannelBinding[]> {
    const profile = (await this.bindingStore.list()).filter(
      (binding) =>
        binding.exactOwnerName === owner.exactOwnerName &&
        binding.ownerInstanceId === owner.ownerInstanceId &&
        binding.platform === ctx.platform &&
        binding.clientName === ctx.clientName &&
        binding.routingMode === 'project-main',
    );
    if (profile.some((binding) => binding.projectKey !== projectKey)) {
      throw multiProjectBindingError();
    }
    const bindings = profile.filter((binding) => binding.projectKey === projectKey);
    const first = bindings[0];
    if (
      first &&
      bindings.some(
        (binding) =>
          binding.sessionId !== first.sessionId || binding.generation !== first.generation,
      )
    ) {
      throw new LocalChannelRootlessError(
        409,
        'CHANNEL_BINDING_PROFILE_DIVERGED',
        'The project-main Channel binding profile has diverged.',
      );
    }
    return bindings;
  }

  private async validateBinding(binding: LocalChannelBinding): Promise<boolean> {
    const owner = await this.options
      .rootlessV2!.getAgentOwnerIdentity(binding.agentName)
      .catch(() => undefined);
    if (
      !owner ||
      !(await isCompatibleChannelAgentOwner({
        persisted: binding,
        current: owner,
        ...(this.options.resolveAgentReadScope
          ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
          : {}),
      }))
    ) {
      return false;
    }
    const session = await this.options.getSessionById(binding.sessionId);
    return Boolean(session && (await this.validateSession(session, owner, binding.projectKey)));
  }

  private async validateSession(
    session: LocalSessionRecord,
    owner: ChannelAgentOwnerIdentity,
    projectKey: string,
  ): Promise<boolean> {
    if (
      session.runtime !== 'pi-agent' ||
      session.sessionType !== 'branch' ||
      session.sessionKind !== 'channel' ||
      session.parentSessionId ||
      session.archived
    ) {
      return false;
    }
    const rootless = this.options.rootlessV2!;
    const project = await rootless.getSessionProjectIdentity(session.sessionId);
    if (!project || project.projectKey !== projectKey) return false;
    const snapshot = await rootless.getSessionAgentRoutingSnapshot(session.sessionId);
    return Boolean(
      snapshot &&
      (await isCompatibleChannelAgentOwner({
        persisted: snapshot,
        current: owner,
        ...(this.options.resolveAgentReadScope
          ? { resolveAgentReadScope: this.options.resolveAgentReadScope }
          : {}),
      })),
    );
  }

  private resolvedFromBinding(binding: LocalChannelBinding): LocalChannelResolvedRoute {
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
}

async function assertCurrentOwner(
  preview: LocalChannelRoutePreview,
  owner: ChannelAgentOwnerIdentity,
  resolveAgentReadScope: LocalChannelBridgeInfraOptions['resolveAgentReadScope'],
): Promise<void> {
  if (preview.ownerDefaultApplied) return;
  if (
    !(await isCompatibleChannelAgentOwner({
      persisted: preview,
      current: owner,
      ...(resolveAgentReadScope ? { resolveAgentReadScope } : {}),
    }))
  ) {
    throw new LocalChannelRootlessError(
      409,
      'CHANNEL_ROUTE_OWNER_STALE',
      'The Channel route targets a stale Agent owner.',
    );
  }
}

function assertRequestedOwner(
  requestedInstanceId: string | undefined,
  owner: {
    ownerKind: 'builtin' | 'custom';
    ownerInstanceId?: string;
  },
): void {
  if (
    (owner.ownerKind === 'custom' && owner.ownerInstanceId !== requestedInstanceId) ||
    (owner.ownerKind === 'builtin' && requestedInstanceId !== undefined)
  ) {
    throw new LocalChannelRootlessError(
      409,
      'CHANNEL_ROUTE_OWNER_STALE',
      'The requested Agent owner incarnation is stale.',
    );
  }
}
