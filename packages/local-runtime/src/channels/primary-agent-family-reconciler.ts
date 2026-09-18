import {
  normalizePrimaryAgentResolutionConflict,
  PRIMARY_AGENT_CHANNEL_CONFLICT,
  PrimaryAgentChannelConflictError,
  type ChannelAgentReadScopeResolver,
} from '../api/host-channel-family-gate.js';
import { imLogger as logger } from '../common/im-logger.js';
import type { LocalAccessControlStore } from './access-control-store.js';
import type {
  ChannelFamilyMutationHook,
  ChannelFamilyMutationKind,
} from './channel-family-mutation.js';
import type { LocalChannelBindingStore } from './infra.js';
import type { LocalChannelOwnerStore } from './owner-store.js';
import {
  createPrimaryFamilyPlatformPorts,
  type PrimaryFamilyPlatformPort,
  type PrimaryFamilyPlatformStores,
} from './primary-agent-family-platforms.js';
import { runPrimaryAgentFamilyReconcile } from './primary-agent-family-reconcile-runner.js';
import {
  cleanupPrimaryFamilyUnbound,
  cleanupSettledPrimaryFamilyShadow,
} from './primary-agent-family-unbind-cleanup.js';
import type { ChannelPlatform } from './route-api.js';

export { PRIMARY_AGENT_BINDING_OWNER_MISSING } from './primary-agent-family-reconcile-runner.js';

const CHANNEL_PLATFORMS: readonly ChannelPlatform[] = ['feishu', 'telegram', 'wechat'];
/** Bare name the family is resolved from; never a caller-supplied `agent:main`. */
const PRIMARY_FAMILY_REQUEST_NAME = 'mavis';
/** Bounded reconcile event (plan §13): names and outcome only, never credentials. */
const RECONCILE_EVENT = 'primary_agent_channel_reconcile';

export type PrimaryAgentChannelReconcileOutcome = 'no_op' | 'migrated' | 'merged' | 'conflict';

export interface PrimaryAgentChannelReconcileResult {
  readonly platform: ChannelPlatform;
  readonly outcome: PrimaryAgentChannelReconcileOutcome;
  readonly canonicalAgentName?: string;
  /** Physical credential / transport owner; canonical stays the Mavis view. */
  readonly winnerAgentName?: string;
  readonly legacyAgentName?: string;
  /** True when the physical winner record is enabled and its transport was started. */
  readonly winnerActive: boolean;
  readonly reasons?: readonly string[];
}

export interface PrimaryAgentFamilyReconcilerInput {
  /**
   * The host's Agent resolver. The family is ALWAYS derived by resolving the
   * bare canonical name through it — the channel layer must never carry its own
   * `['mavis', 'main']` list, and must never trust a caller-supplied
   * `agent:main`.
   */
  readonly resolveAgentReadScope: ChannelAgentReadScopeResolver;
  readonly stores: PrimaryFamilyPlatformStores;
  readonly bindingStore: LocalChannelBindingStore;
  readonly ownerStore: LocalChannelOwnerStore;
  readonly accessControlStore?: LocalAccessControlStore;
  readonly dataDir: () => string;
  readonly nowMs: () => number;
  readonly defaultAgentName: string;
  /** Stop a live transport: Feishu `invalidateTransport()`, TG/WeChat `shutdown()`. */
  teardownTransport(platform: ChannelPlatform, agentName: string): Promise<void> | void;
  /** Drop the record's outbound client + adapter from both registries. */
  unregisterTransport(platform: ChannelPlatform, clientId: string): void;
  /** Register + start the physical winner's transport (step 7). */
  startTransport(platform: ChannelPlatform, agentName: string): Promise<void> | void;
}

export interface ResolvedFamily {
  readonly canonicalName: string;
  /** Agent core's exact physical credential owner (Main before V2 seeding). */
  readonly winnerName: string;
  /** Every other trusted family name; it remains an exact unbindable shadow. */
  readonly legacyNames: readonly string[];
}

/**
 * Converge the primary Agent family onto one enabled channel owner per platform
 * (plan §5).
 *
 * Resolution, mutation serialisation, and exact-unbind handling live here;
 * the sibling runner performs only the durable credential/state plan.
 */
export class PrimaryAgentFamilyReconciler {
  private readonly ports: Record<ChannelPlatform, PrimaryFamilyPlatformPort>;
  /**
   * Per `canonical family + platform` serialisation tail, mirroring
   * `LocalChannelOwnerStore.serialise`. This is an in-process lock only; disk
   * recovery relies on the scan being idempotent, not on the lock surviving.
   */
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly input: PrimaryAgentFamilyReconcilerInput) {
    this.ports = createPrimaryFamilyPlatformPorts(input.stores);
  }

  /**
   * Reconcile every platform in a stable order. Resolver identity conflicts
   * intentionally reject and fail closed; only an unresolved family is `no_op`.
   */
  async reconcileAll(): Promise<PrimaryAgentChannelReconcileResult[]> {
    const results: PrimaryAgentChannelReconcileResult[] = [];
    for (const platform of CHANNEL_PLATFORMS) {
      results.push(await this.reconcile(platform));
    }
    return results;
  }

  async reconcile(platform: ChannelPlatform): Promise<PrimaryAgentChannelReconcileResult> {
    const family = await this.resolveFamily();
    if (!family) {
      logger.info(
        { platform, outcome: 'no_op', reason: 'family_unresolved' },
        'primary_agent_channel_reconcile',
      );
      return { platform, outcome: 'no_op', winnerActive: false };
    }
    return this.serialise(`${family.canonicalName}:${platform}`, () =>
      this.runReconcile(platform, family),
    );
  }

  /**
   * The shared store write seam (plan §5.2). One hook object drives all three
   * platform stores: staging a family candidate disabled before persist, and
   * converging inside the family lock afterwards.
   */
  mutationHook(platform: ChannelPlatform): ChannelFamilyMutationHook {
    return {
      isPrimaryFamilyAgent: async (agentName: string, kind: ChannelFamilyMutationKind = 'bind') => {
        let family: ResolvedFamily | undefined;
        try {
          family = await this.resolveFamily();
        } catch (error) {
          // The exact credential deletion already committed before this hook
          // runs. A manual reserved-name conflict must not turn that successful
          // unbind into a rejected request; only a new bind fails closed.
          if (kind === 'unbind') return false;
          throw (
            normalizePrimaryAgentResolutionConflict(error, {
              platform,
              canonicalAgentName: PRIMARY_FAMILY_REQUEST_NAME,
              agentNames: [agentName],
            }) ?? error
          );
        }
        if (!family) {
          // `resolveFamily()` intentionally returns undefined for an untrusted
          // family. Exact unbind stays available for that pre-existing row.
          if (kind === 'unbind') return false;
          const scope = await this.input.resolveAgentReadScope(PRIMARY_FAMILY_REQUEST_NAME);
          const canonicalName = scope.canonicalName.trim();
          const familyNames = [
            canonicalName,
            ...(scope.compatibleNames ?? []).map((name) => name.trim()).filter(Boolean),
          ];
          const name = agentName.trim();
          if (kind === 'bind' && scope.trustedBuiltin === false && familyNames.includes(name)) {
            const winnerName = scope.exactOwnerName?.trim() || canonicalName;
            logger.error(
              {
                platform,
                outcome: 'conflict',
                canonical_agent: canonicalName,
                winner_agent: winnerName,
                reason: 'untrusted_primary_agent',
                code: PRIMARY_AGENT_CHANNEL_CONFLICT,
              },
              RECONCILE_EVENT,
            );
            throw new PrimaryAgentChannelConflictError({
              platform,
              canonicalAgentName: canonicalName,
              agentNames: [...new Set(familyNames)],
            });
          }
          return false;
        }
        // `legacyNames` deliberately excludes the physical winner. Include it
        // explicitly so a Main-only pre-V2 bind/unbind still enters this hook.
        const name = agentName.trim();
        return (
          name === family.canonicalName ||
          name === family.winnerName ||
          family.legacyNames.includes(name)
        );
      },
      afterMutation: async ({ agentName, kind, unbound }) => {
        let family: ResolvedFamily | undefined;
        try {
          family = await this.resolveFamily();
        } catch (error) {
          // Exact unbind must remain recoverable even if a manual reservation
          // appears concurrently. A bind has already been staged disabled, so
          // surface the narrow stable conflict instead of leaking V2 internals.
          if (kind === 'unbind') return;
          throw (
            normalizePrimaryAgentResolutionConflict(error, {
              platform,
              canonicalAgentName: PRIMARY_FAMILY_REQUEST_NAME,
              agentNames: [agentName],
            }) ?? error
          );
        }
        if (!family) return;
        // One lock covers the unbind cleanup AND the reconcile, so a concurrent
        // bind cannot observe the half-cleaned intermediate state.
        const result = await this.serialise(`${family.canonicalName}:${platform}`, async () => {
          if (kind === 'unbind') {
            await cleanupPrimaryFamilyUnbound(
              this.input,
              platform,
              this.ports[platform],
              agentName,
              family,
            );
            await cleanupSettledPrimaryFamilyShadow(
              this.input,
              platform,
              this.ports[platform],
              family,
              agentName,
              unbound,
            );
          }
          return this.runReconcile(platform, family);
        });
        if (kind === 'unbind') return;
        if (result.winnerActive) return;
        // A bind that did not end with an active physical winner must FAIL:
        // returning "ok" would leave the user believing a disabled shadow is
        // their live binding.
        logger.error(
          {
            platform,
            outcome: result.outcome,
            canonical_agent: result.canonicalAgentName,
            winner_agent: result.winnerAgentName ?? family.winnerName,
            legacy_agent: result.legacyAgentName,
            reason: 'mutation_did_not_activate_winner',
            code: PRIMARY_AGENT_CHANNEL_CONFLICT,
          },
          'primary_agent_channel_reconcile',
        );
        throw new PrimaryAgentChannelConflictError({
          platform,
          canonicalAgentName: result.canonicalAgentName ?? agentName,
          agentNames: [agentName, ...(result.legacyAgentName ? [result.legacyAgentName] : [])],
        });
      },
    };
  }

  private runReconcile(
    platform: ChannelPlatform,
    family: ResolvedFamily,
  ): Promise<PrimaryAgentChannelReconcileResult> {
    return runPrimaryAgentFamilyReconcile(this.input, this.ports, platform, family);
  }

  /**
   * Resolve the trusted family at each reconcile or mutation boundary. Agent
   * ownership can change while the process lives, so cache neither a winner nor
   * an unresolved or rejected result; the canonical lock still serialises work.
   */
  private async resolveFamily(): Promise<ResolvedFamily | undefined> {
    const scope = await this.input.resolveAgentReadScope(PRIMARY_FAMILY_REQUEST_NAME);
    const canonicalName = scope.canonicalName.trim();
    if (!canonicalName) {
      logger.warn({ reason: 'canonical_name_missing' }, 'primary_agent_channel_family_unresolved');
      return undefined;
    }
    const winnerName = scope.exactOwnerName?.trim() || canonicalName;
    if (scope.trustedBuiltin === false) {
      logger.warn(
        {
          canonical_agent: canonicalName,
          winner_agent: winnerName,
          reason: 'untrusted_primary_agent',
        },
        'primary_agent_channel_family_unresolved',
      );
      return undefined;
    }
    const names = [
      canonicalName,
      ...(scope.compatibleNames ?? []).map((name) => name.trim()).filter(Boolean),
    ];
    const familyNames = [...new Set(names)];
    if (!familyNames.includes(winnerName)) {
      logger.warn(
        {
          canonical_agent: canonicalName,
          winner_agent: winnerName,
          reason: 'winner_not_trusted_family_member',
        },
        'primary_agent_channel_family_unresolved',
      );
      return undefined;
    }
    return {
      canonicalName,
      winnerName,
      legacyNames: familyNames.filter((name) => name !== winnerName),
    };
  }

  private serialise<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.pending.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => task());
    const tracked = next.finally(() => {
      if (this.pending.get(key) === tracked) this.pending.delete(key);
    });
    this.pending.set(key, tracked);
    // `tracked` is an internal lock tail; callers observe `next`. Consume the
    // tail's duplicate rejection so a tested transport-start failure does not
    // surface as a separate unhandled promise after the caller handled it.
    void tracked.catch(() => undefined);
    return next;
  }
}
