import type { ChannelAgentReadScopeResolver } from '../api/host-channel-family-gate.js';
import { imLogger as logger } from '../common/im-logger.js';

/** Bounded Root reconcile event (plan §13): keeper_session_id / demoted_count. */
const ROOT_RECONCILE_EVENT = 'primary_agent_root_reconcile';
/** Bare name the family is resolved from; never a caller-supplied `agent:main`. */
const PRIMARY_FAMILY_REQUEST_NAME = 'mavis';

/** The Session facts the keeper decision needs; deliberately not a full record. */
export interface PrimaryFamilyRootView {
  readonly sessionId: string;
  readonly agentName: string;
  readonly runtime: string;
  readonly sessionType: string;
  readonly sessionKind: string;
  readonly archived: boolean;
  readonly updatedAtMs: number;
}

/**
 * The existing Session capabilities the reconciler drives. Every one of them is
 * an EXISTING V2 path: this module owns no SQL, never writes the Session table
 * and never re-implements the family-aware `swapRoot()`.
 */
export interface PrimaryFamilyRootSessionPort {
  /**
   * Conversation Roots owned by exactly one Agent name. Task / subagent / cron
   * / channel trees and non-`pi-agent` runtimes must already be excluded here.
   */
  listConversationRoots(agentName: string): Promise<readonly PrimaryFamilyRootView[]>;
  /** Existing family-aware Root replacement; returns the demoted Root ids. */
  replaceRoot(
    agentName: string,
    sessionId: string,
  ): Promise<{ readonly previousRootSessionIds: readonly string[] }>;
  /** Existing Root create/get path. Never a direct row insert. */
  ensureRoot(agentName: string): Promise<PrimaryFamilyRootView | undefined>;
  /** Current `rootSessionId` pointer of one Agent row, when the row exists. */
  getAgentRootPointer(agentName: string): Promise<string | undefined>;
  /** Whether a trusted Agent row exists at all; a missing row is skipped, not failed. */
  agentExists(agentName: string): Promise<boolean>;
}

export interface PrimaryAgentRootReconcilerInput {
  /** Family ALWAYS comes from the resolver; the channel layer keeps no name list. */
  readonly resolveAgentReadScope: ChannelAgentReadScopeResolver;
  readonly sessions: PrimaryFamilyRootSessionPort;
}

export type PrimaryAgentRootReconcileOutcome = 'no_op' | 'converged' | 'created' | 'skipped';

export interface PrimaryAgentRootReconcileResult {
  readonly outcome: PrimaryAgentRootReconcileOutcome;
  readonly keeperSessionId?: string;
  readonly demotedCount: number;
  /**
   * The startup model check only touches the keeper Root. The Turn gate repairs
   * all historical Sessions lazily.
   */
  readonly scopedSessionIds: readonly string[];
}

/** Where the keeper came from; logged so a surprising keeper is explainable. */
type KeeperSource =
  | 'exact_owner_pointer'
  | 'compatible_pointer'
  | 'latest_unarchived_root'
  | 'lexicographic_tiebreak';

/**
 * Converge the primary Agent family onto ONE pi-agent conversation Root
 * (plan §7).
 *
 * It adds exactly the one thing PreviewTrain lacked: noticing a dirty double
 * Root at boot and calling the EXISTING family-aware Root replacement. Keeper
 * selection is a pure, totally ordered decision so two boots over the same disk
 * state always pick the same Root; the demotion, the archive title and the
 * Agent pointer repair are all existing behaviour
 * reached through {@link PrimaryFamilyRootSessionPort}.
 */
export class PrimaryAgentRootReconciler {
  constructor(private readonly input: PrimaryAgentRootReconcilerInput) {}

  async reconcile(): Promise<PrimaryAgentRootReconcileResult> {
    const family = await this.resolveFamily();
    if (!family) {
      // Already logged with a reason by `resolveFamily`; repeated here so the
      // Root step's own outcome is never inferred from a missing line.
      logger.info({ outcome: 'skipped', reason: 'family_unresolved' }, ROOT_RECONCILE_EVENT);
      return { outcome: 'skipped', demotedCount: 0, scopedSessionIds: [] };
    }
    const candidates = await this.listFamilyRoots(family.names);
    if (candidates.length === 0) return this.createMissingRoot(family);

    const keeper = pickKeeper({
      candidates,
      exactOwnerName: family.exactOwnerName,
      names: family.names,
      pointers: await this.readPointers(family.names),
    });
    logger.info(
      {
        canonical_agent: family.canonicalName,
        winner_agent: family.winnerName,
        reason: 'keeper_selected',
        keeper_session_id: keeper.root.sessionId,
        keeper_source: keeper.source,
        candidate_count: candidates.length,
      },
      ROOT_RECONCILE_EVENT,
    );

    const demoted = await this.converge(family, keeper.root, candidates);
    await this.assertConverged(family, keeper.root.sessionId);
    const scopedSessionIds = [keeper.root.sessionId];
    const outcome = demoted.size > 0 ? 'converged' : 'no_op';
    logger.info(
      {
        canonical_agent: family.canonicalName,
        winner_agent: family.winnerName,
        outcome,
        reason: outcome === 'converged' ? 'roots_converged' : 'roots_already_converged',
        keeper_session_id: keeper.root.sessionId,
        demoted_count: demoted.size,
        scoped_session_count: scopedSessionIds.length,
      },
      ROOT_RECONCILE_EVENT,
    );
    return {
      outcome,
      keeperSessionId: keeper.root.sessionId,
      demotedCount: demoted.size,
      scopedSessionIds,
    };
  }

  /**
   * Point every trusted family Agent row at the keeper. The FIRST call performs
   * the actual demotion inside the existing transactional family swap; the
   * later ones find nothing to demote and only repair their own pointer, which
   * is exactly why `main` and `mavis` end up agreeing without a second
   * pointer-writing code path.
   */
  private async converge(
    family: ResolvedRootFamily,
    keeper: PrimaryFamilyRootView,
    candidates: readonly PrimaryFamilyRootView[],
  ): Promise<Set<string>> {
    const demoted = new Set<string>();
    const losers = candidates.filter((root) => root.sessionId !== keeper.sessionId);
    const pointers = await this.readPointers(family.names);
    for (const name of family.names) {
      const pointer = pointers.get(name);
      // A name with no Agent row (pure-mavis install, or a legacy `main` that
      // was never created) has nothing to repair and must not fail the step.
      if (!family.rows.has(name)) {
        logger.info(
          {
            canonical_agent: family.canonicalName,
            winner_agent: family.winnerName,
            keeper_session_id: keeper.sessionId,
            agentName: name,
            reason: 'agent_row_absent',
          },
          ROOT_RECONCILE_EVENT,
        );
        continue;
      }
      if (losers.length === 0 && pointer === keeper.sessionId) {
        logger.info(
          {
            canonical_agent: family.canonicalName,
            winner_agent: family.winnerName,
            keeper_session_id: keeper.sessionId,
            agentName: name,
            reason: 'pointer_already_keeper',
          },
          ROOT_RECONCILE_EVENT,
        );
        continue;
      }
      const replaced = await this.input.sessions.replaceRoot(name, keeper.sessionId);
      for (const sessionId of replaced.previousRootSessionIds) demoted.add(sessionId);
    }
    return demoted;
  }

  /** Zero family Roots: go through the existing create/get path, never an insert. */
  private async createMissingRoot(
    family: ResolvedRootFamily,
  ): Promise<PrimaryAgentRootReconcileResult> {
    // The Agent core selects the physical owner. A pre-V2 Main-only install
    // must keep its Root on `main`; if no trusted row exists yet, core seeding
    // runs first and this reconciler deliberately makes no write.
    if (!family.rows.has(family.winnerName)) {
      logger.warn(
        {
          canonical_agent: family.canonicalName,
          winner_agent: family.winnerName,
          outcome: 'skipped',
          reason: 'winner_agent_row_absent',
        },
        ROOT_RECONCILE_EVENT,
      );
      return { outcome: 'skipped', demotedCount: 0, scopedSessionIds: [] };
    }
    const created = await this.input.sessions.ensureRoot(family.winnerName);
    if (!created) throw new Error('PRIMARY_AGENT_ROOT_CREATION_FAILED');
    const demoted = await this.converge(family, created, [created]);
    await this.assertConverged(family, created.sessionId);
    const scopedSessionIds = [created.sessionId];
    logger.info(
      {
        canonical_agent: family.canonicalName,
        winner_agent: family.winnerName,
        outcome: 'created',
        reason: 'root_created',
        keeper_session_id: created.sessionId,
        demoted_count: demoted.size,
      },
      ROOT_RECONCILE_EVENT,
    );
    return {
      outcome: 'created',
      keeperSessionId: created.sessionId,
      demotedCount: demoted.size,
      scopedSessionIds,
    };
  }

  /**
   * Scan each exact family name and keep only pi-agent conversation Roots
   * (§7.1). Task, subagent, cron and channel trees never participate: they are
   * separate internal trees, and adopting one as the user's Main would move a
   * whole conversation history behind an internal purpose.
   */
  private async listFamilyRoots(
    names: readonly string[],
  ): Promise<readonly PrimaryFamilyRootView[]> {
    const byId = new Map<string, PrimaryFamilyRootView>();
    for (const name of names) {
      for (const session of await this.input.sessions.listConversationRoots(name)) {
        if (session.runtime !== 'pi-agent') {
          logger.info(
            { sessionId: session.sessionId, reason: 'skipped_runtime', runtime: session.runtime },
            ROOT_RECONCILE_EVENT,
          );
          continue;
        }
        if (session.sessionType !== 'root' || session.sessionKind !== 'conversation') {
          logger.info(
            {
              sessionId: session.sessionId,
              reason: 'skipped_session_shape',
              sessionType: session.sessionType,
              sessionKind: session.sessionKind,
            },
            ROOT_RECONCILE_EVENT,
          );
          continue;
        }
        byId.set(session.sessionId, session);
      }
    }
    return [...byId.values()];
  }

  private async readPointers(names: readonly string[]): Promise<Map<string, string | undefined>> {
    const pointers = new Map<string, string | undefined>();
    for (const name of names) {
      pointers.set(name, await this.input.sessions.getAgentRootPointer(name));
    }
    return pointers;
  }

  private async assertConverged(
    family: ResolvedRootFamily,
    keeperSessionId: string,
  ): Promise<void> {
    const roots = await this.listFamilyRoots(family.names);
    if (roots.length !== 1 || roots[0]?.sessionId !== keeperSessionId) {
      throw new Error('PRIMARY_AGENT_ROOT_CONVERGENCE_FAILED: roots_not_converged');
    }
    for (const name of family.rows) {
      if ((await this.input.sessions.getAgentRootPointer(name)) !== keeperSessionId) {
        throw new Error(`PRIMARY_AGENT_ROOT_CONVERGENCE_FAILED: pointer:${name}`);
      }
    }
  }

  /**
   * Resolve the trusted family once. `undefined` disables the whole step — a
   * reserved name held by an untrusted Agent must never cause a Root swap.
   */
  private async resolveFamily(): Promise<ResolvedRootFamily | undefined> {
    const scope = await this.input.resolveAgentReadScope(PRIMARY_FAMILY_REQUEST_NAME);
    const canonicalName = scope.canonicalName.trim();
    if (!canonicalName) {
      logger.warn({ reason: 'canonical_name_missing' }, 'primary_agent_root_family_unresolved');
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
        'primary_agent_root_family_unresolved',
      );
      return undefined;
    }
    const names = [
      canonicalName,
      ...(scope.compatibleNames ?? []).map((name) => name.trim()).filter(Boolean),
    ];
    const unique = [...new Set(names)];
    if (!unique.includes(winnerName)) {
      logger.warn(
        {
          canonical_agent: canonicalName,
          winner_agent: winnerName,
          reason: 'winner_not_trusted_family_member',
        },
        'primary_agent_root_family_unresolved',
      );
      return undefined;
    }
    const rows = new Set<string>();
    for (const name of unique) {
      if (await this.input.sessions.agentExists(name)) rows.add(name);
    }
    return {
      canonicalName,
      winnerName,
      names: unique,
      rows,
      ...(scope.exactOwnerName?.trim() ? { exactOwnerName: scope.exactOwnerName.trim() } : {}),
    };
  }
}

interface ResolvedRootFamily {
  readonly canonicalName: string;
  /** Physical Root owner chosen by Agent core; canonical remains the Mavis view. */
  readonly winnerName: string;
  /** Canonical first, then the trusted legacy members, deduplicated. */
  readonly names: readonly string[];
  /** Names whose Agent row currently exposes a Root pointer. */
  readonly rows: ReadonlySet<string>;
  readonly exactOwnerName?: string;
}

/**
 * The stable keeper priority of plan §7.2. Pure and total: given the same
 * candidates and pointers it always returns the same Root, so two
 * consecutive boots cannot swap the user's Main back and forth.
 */
function pickKeeper(input: {
  readonly candidates: readonly PrimaryFamilyRootView[];
  readonly exactOwnerName?: string;
  readonly names: readonly string[];
  readonly pointers: ReadonlyMap<string, string | undefined>;
}): { readonly root: PrimaryFamilyRootView; readonly source: KeeperSource } {
  const byId = new Map(input.candidates.map((root) => [root.sessionId, root]));

  // 1/2. Agent pointers: the persisted exact owner first, then the other
  // trusted family rows in resolver order.
  const pointerNames = [
    ...(input.exactOwnerName ? [input.exactOwnerName] : []),
    ...input.names.filter((name) => name !== input.exactOwnerName),
  ];
  for (const [index, name] of pointerNames.entries()) {
    const pointer = input.pointers.get(name);
    const root = pointer ? byId.get(pointer) : undefined;
    if (!root) continue;
    return {
      root,
      source: index === 0 && input.exactOwnerName ? 'exact_owner_pointer' : 'compatible_pointer',
    };
  }

  // 3/4. Newest unarchived conversation Root, `sessionId` as the final,
  // deterministic tie-break.
  const ordered = [...input.candidates].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || a.sessionId.localeCompare(b.sessionId),
  );
  const unarchived = ordered.filter((root) => !root.archived);
  const latest = unarchived[0];
  if (latest) return { root: latest, source: 'latest_unarchived_root' };
  return { root: ordered[0]!, source: 'lexicographic_tiebreak' };
}
