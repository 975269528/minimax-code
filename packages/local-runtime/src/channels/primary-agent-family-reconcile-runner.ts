import { PRIMARY_AGENT_CHANNEL_CONFLICT } from '../api/host-channel-family-gate.js';
import { imLogger as logger } from '../common/im-logger.js';
import type {
  PrimaryAgentChannelReconcileResult,
  PrimaryAgentFamilyReconcilerInput,
  ResolvedFamily,
} from './primary-agent-family-reconciler.js';
import {
  identitiesMatch,
  pickCredentialSource,
  type PrimaryFamilyPlatformPort,
  type PrimaryFamilyRecordView,
} from './primary-agent-family-platforms.js';
import { migratePrimaryFamilyState } from './primary-agent-family-state.js';
import type { ChannelPlatform } from './route-api.js';

/**
 * Stable error code for "the winner the reconciler was about to enable has no
 * credential record left" (plan §13). Fail closed: an enabled binding with no
 * owning credential would be an orphan transport nobody can unbind.
 */
export const PRIMARY_AGENT_BINDING_OWNER_MISSING = 'PRIMARY_AGENT_BINDING_OWNER_MISSING';

/** Bounded reconcile event (plan §13): names and outcome only, never credentials. */
const RECONCILE_EVENT = 'primary_agent_channel_reconcile';

interface ReconcileContext {
  readonly input: PrimaryAgentFamilyReconcilerInput;
  readonly ports: Record<ChannelPlatform, PrimaryFamilyPlatformPort>;
  readonly platform: ChannelPlatform;
  readonly family: ResolvedFamily;
}

/**
 * Executes the durable credential/state plan after the reconciler has resolved
 * and serialised one trusted family. Resolution, cache ownership, and mutation
 * locking stay in the parent so this module cannot change those boundaries.
 */
export async function runPrimaryAgentFamilyReconcile(
  input: PrimaryAgentFamilyReconcilerInput,
  ports: Record<ChannelPlatform, PrimaryFamilyPlatformPort>,
  platform: ChannelPlatform,
  family: ResolvedFamily,
): Promise<PrimaryAgentChannelReconcileResult> {
  const context = { input, ports, platform, family } as const;
  const port = ports[platform];
  const records = await port.list();
  // Mavis is the canonical view/lock key, while the Agent core's exact owner
  // is the only physical credential target. This keeps Main-only installs
  // from materializing a second Mavis credential before V2 has seeded it.
  const winner = records.find((record) => record.agentName === family.winnerName);
  const familyLegacies = records.filter((record) => family.legacyNames.includes(record.agentName));
  const base = {
    platform,
    canonicalAgentName: family.canonicalName,
    winnerAgentName: family.winnerName,
  } as const;
  // Bounded log shape (plan §13): platform / outcome / canonical_agent /
  // winner_agent / reason. Never credentials, fingerprints, user messages or ACL members.
  const logBase = {
    platform,
    canonical_agent: family.canonicalName,
    winner_agent: family.winnerName,
  } as const;

  if (!winner && familyLegacies.length === 0) {
    logger.info({ ...logBase, outcome: 'no_op', reason: 'no_family_record' }, RECONCILE_EVENT);
    return { ...base, outcome: 'no_op', winnerActive: false };
  }
  // A DISABLED shadow sitting next to an ENABLED physical winner is the
  // documented terminal state of a successful merge (§5.4: "retain legacy as
  // disabled shadow"), not a competing record. Reading it back as a rival on
  // the next boot is what made a canonical bot-b lose to a settled bot-a
  // shadow through `platform_identity_mismatch`. Only records that could
  // actually receive traffic compete. A missing winner still inspects its
  // legacy row so an enabled, identifiable pre-V2 record can converge; an
  // inert legacy is never promoted merely because the canonical record was
  // exactly unbound.
  const winnerEnabled = winner?.enabled === true;
  const legacies = winnerEnabled
    ? familyLegacies.filter((record) => record.enabled)
    : familyLegacies;
  const settledShadows = winnerEnabled ? familyLegacies.filter((record) => !record.enabled) : [];
  if (legacies.length === 0 && settledShadows.length > 0) {
    return applySettledShadows(context, winner!, settledShadows);
  }
  if (legacies.length > 1) {
    // Three or more family credentials cannot be merged pairwise without
    // guessing which legacy record is authoritative.
    return applyConflict(context, winner, legacies, ['multiple_legacy_records']);
  }
  const legacy = legacies[0];
  if (!legacy) return applyWinnerOnly(context, winner!);

  // An exact unbind may leave only the disabled historical shadow behind.
  // It remains a user-addressable credential record, not evidence that we
  // should clone it into a new canonical binding and start a transport.
  if (!winner && !legacy.enabled) {
    logger.info(
      { ...logBase, outcome: 'no_op', legacy_agent: legacy.agentName, reason: 'legacy_disabled' },
      RECONCILE_EVENT,
    );
    return {
      ...base,
      outcome: 'no_op',
      legacyAgentName: legacy.agentName,
      winnerActive: false,
      reasons: ['legacy_disabled'],
    };
  }
  // With no physical winner, a legacy record has to prove which platform
  // identity it owns before it can be copied. Missing identity is fail-closed:
  // preserve it disabled for exact unbind instead of guessing a new owner.
  if (!winner && !legacy.identity) {
    return applyConflict(context, undefined, [legacy], ['platform_identity_missing']);
  }

  if (winner && !identitiesMatch(winner, legacy)) {
    logger.warn(
      { ...logBase, legacy_agent: legacy.agentName, reason: 'platform_identity_mismatch' },
      RECONCILE_EVENT,
    );
    return applyConflict(context, winner, legacies, ['platform_identity_mismatch']);
  }
  const stateInput = primaryFamilyStateInput(context, legacy, family.winnerName);
  const inspected = await migratePrimaryFamilyState(stateInput, 'inspect');
  if (inspected.conflicts.length > 0) {
    logger.warn(
      {
        ...logBase,
        legacy_agent: legacy.agentName,
        reason: 'associated_state_conflict',
        conflict_count: inspected.conflicts.length,
      },
      RECONCILE_EVENT,
    );
    return applyConflict(context, winner, legacies, inspected.conflicts);
  }
  // Plan §5.5, in this exact order. Steps 4-5 (stop + disable the legacy)
  // ALWAYS precede steps 6-7 (enable + start the physical winner): the reverse
  // order would put two live transports on one bot.
  // 2. winner credential, staged disabled.
  const source = pickCredentialSource(winner, legacy);
  if (source.agentName !== family.winnerName) {
    await port.cloneCredential({
      fromAgentName: source.agentName,
      toAgentName: family.winnerName,
      enabled: false,
    });
  } else {
    await port.setEnabled(family.winnerName, false);
  }
  // 3. associated state.
  await migratePrimaryFamilyState(stateInput, 'apply');
  // 4. stop + unregister the legacy transport.
  await input.teardownTransport(platform, legacy.agentName);
  input.unregisterTransport(platform, legacy.clientId);
  // 5. legacy credential disabled (kept, never deleted, so exact unbind works).
  await port.setEnabled(legacy.agentName, false);
  // 6. winner enabled.
  const enabledWinner = await port.setEnabled(family.winnerName, true);
  if (!enabledWinner) {
    logger.error(
      {
        ...logBase,
        legacy_agent: legacy.agentName,
        outcome: 'conflict',
        reason: 'binding_owner_missing',
        code: PRIMARY_AGENT_BINDING_OWNER_MISSING,
      },
      RECONCILE_EVENT,
    );
    return applyConflict(context, winner, legacies, [PRIMARY_AGENT_BINDING_OWNER_MISSING]);
  }
  // 7. register + start the single winner. A failed start must not leave a
  // persisted enabled row pointing at a dead or partially created client.
  await startWinnerTransport(context);
  const outcome = winner ? 'merged' : 'migrated';
  logger.info(
    { ...logBase, outcome, legacy_agent: legacy.agentName, reason: 'family_converged' },
    RECONCILE_EVENT,
  );
  return { ...base, outcome, legacyAgentName: legacy.agentName, winnerActive: true };
}

/**
 * The physical winner already won and every remaining legacy record is a
 * settled, disabled shadow (§5.4 terminal state). Nothing is torn down and
 * nothing is disabled here: the live winner must survive its own success.
 *
 * A shadow may still own route / binding / Owner / ACL rows if a previous run
 * crashed between §5.5 steps 3 and 5, so leftovers are moved onto the
 * physical winner client first. A shadow whose leftovers would CONFLICT is left
 * exactly as it is — refusing to merge a dead record's state must not cost
 * the user the transport they just bound.
 */
async function applySettledShadows(
  context: ReconcileContext,
  winner: PrimaryFamilyRecordView,
  shadows: readonly PrimaryFamilyRecordView[],
): Promise<PrimaryAgentChannelReconcileResult> {
  const { family, platform } = context;
  const base = {
    platform,
    canonicalAgentName: family.canonicalName,
    winnerAgentName: family.winnerName,
  } as const;
  const logBase = {
    platform,
    canonical_agent: family.canonicalName,
    winner_agent: family.winnerName,
    reason: 'settled_legacy_shadow',
    shadow_count: shadows.length,
  } as const;
  let moved = 0;
  let identityMismatch = false;
  for (const shadow of shadows) {
    if (!identitiesMatch(winner, shadow)) {
      identityMismatch = true;
      logger.warn(
        { ...logBase, legacy_agent: shadow.agentName, reason: 'platform_identity_mismatch' },
        RECONCILE_EVENT,
      );
      continue;
    }
    const stateInput = primaryFamilyStateInput(context, shadow, family.winnerName);
    const inspected = await migratePrimaryFamilyState(stateInput, 'inspect');
    if (inspected.conflicts.length > 0) {
      logger.warn(
        {
          ...logBase,
          legacy_agent: shadow.agentName,
          reason: 'associated_state_conflict',
          conflict_count: inspected.conflicts.length,
        },
        RECONCILE_EVENT,
      );
      continue;
    }
    if (inspected.moved + inspected.deduped === 0) continue;
    await migratePrimaryFamilyState(stateInput, 'apply');
    moved += inspected.moved + inspected.deduped;
  }
  const outcome = moved > 0 ? 'merged' : 'no_op';
  logger.info({ ...logBase, outcome, legacy_agent: shadows[0]?.agentName, moved }, RECONCILE_EVENT);
  return {
    ...base,
    outcome,
    ...(shadows[0] ? { legacyAgentName: shadows[0].agentName } : {}),
    winnerActive: true,
    reasons: [
      'settled_legacy_shadow',
      ...(identityMismatch ? ['settled_legacy_shadow_identity_mismatch'] : []),
    ],
  };
}

/** Shared §6 state-migration descriptor: one shadow client onto the physical winner. */
function primaryFamilyStateInput(
  context: ReconcileContext,
  legacy: PrimaryFamilyRecordView,
  winnerName: string,
): Parameters<typeof migratePrimaryFamilyState>[0] {
  const { input, platform, ports } = context;
  return {
    platform,
    legacy: { agentName: legacy.agentName, clientId: legacy.clientId },
    canonical: {
      agentName: winnerName,
      clientId: ports[platform].clientId(winnerName),
    },
    bindingStore: input.bindingStore,
    ownerStore: input.ownerStore,
    ...(input.accessControlStore ? { accessControlStore: input.accessControlStore } : {}),
    dataDir: input.dataDir,
    nowMs: input.nowMs,
    defaultAgentName: input.defaultAgentName,
  };
}

/** Only the physical winner record exists: validate it, enabling it when needed. */
async function applyWinnerOnly(
  context: ReconcileContext,
  winner: PrimaryFamilyRecordView,
): Promise<PrimaryAgentChannelReconcileResult> {
  const { family, input, platform, ports } = context;
  const base = {
    platform,
    canonicalAgentName: family.canonicalName,
    winnerAgentName: family.winnerName,
  } as const;
  const logBase = {
    platform,
    canonical_agent: family.canonicalName,
    winner_agent: family.winnerName,
  } as const;
  if (winner.enabled) {
    logger.info({ ...logBase, outcome: 'no_op', reason: 'winner_only_enabled' }, RECONCILE_EVENT);
    return { ...base, outcome: 'no_op', winnerActive: true };
  }
  // Reached after a resolved conflict (the user unbound the other record) or
  // a crash between §5.5 steps 5 and 6. A prior credential/transport may
  // still be alive for this record, so stop it before enabling the winner.
  await input.teardownTransport(platform, family.winnerName);
  input.unregisterTransport(platform, winner.clientId);
  const enabledWinner = await ports[platform].setEnabled(family.winnerName, true);
  if (!enabledWinner) {
    return applyConflict(context, winner, [], [PRIMARY_AGENT_BINDING_OWNER_MISSING]);
  }
  await startWinnerTransport(context);
  logger.info(
    { ...logBase, outcome: 'migrated', reason: 'winner_only_recovered' },
    RECONCILE_EVENT,
  );
  return { ...base, outcome: 'migrated', winnerActive: true };
}

/**
 * Conflict (plan §5.4): tear down BOTH sides first, then persist both as
 * disabled. Never "pick one and carry on" — that is precisely how the wrong
 * bot or the wider ACL keeps receiving messages. Records are kept so the user
 * can still unbind either one by its exact bindingId.
 */
async function applyConflict(
  context: ReconcileContext,
  winner: PrimaryFamilyRecordView | undefined,
  legacies: readonly PrimaryFamilyRecordView[],
  reasons: readonly string[],
): Promise<PrimaryAgentChannelReconcileResult> {
  const { family, input, platform, ports } = context;
  const port = ports[platform];
  const involved = [...(winner ? [winner] : []), ...legacies];
  for (const record of involved) {
    await input.teardownTransport(platform, record.agentName);
    input.unregisterTransport(platform, record.clientId);
  }
  for (const record of involved) {
    await port.setEnabled(record.agentName, false);
  }
  logger.error(
    {
      platform,
      outcome: 'conflict',
      canonical_agent: family.canonicalName,
      winner_agent: family.winnerName,
      legacy_agent: legacies[0]?.agentName,
      reason: reconcileConflictReason(reasons),
      conflict_count: reasons.length,
      code: PRIMARY_AGENT_CHANNEL_CONFLICT,
    },
    RECONCILE_EVENT,
  );
  return {
    platform,
    outcome: 'conflict',
    canonicalAgentName: family.canonicalName,
    winnerAgentName: family.winnerName,
    ...(legacies[0] ? { legacyAgentName: legacies[0].agentName } : {}),
    winnerActive: false,
    reasons,
  };
}

/** Collapse store-specific conflict keys before logging to keep fields bounded. */
function reconcileConflictReason(reasons: readonly string[]): string {
  if (reasons.includes('platform_identity_mismatch')) return 'platform_identity_mismatch';
  if (reasons.includes('platform_identity_missing')) return 'platform_identity_missing';
  if (reasons.includes('multiple_legacy_records')) return 'multiple_family_records';
  if (reasons.includes(PRIMARY_AGENT_BINDING_OWNER_MISSING)) return 'binding_owner_missing';
  return 'associated_state_conflict';
}

/**
 * Start only an enabled winner, and compensate the durable state if the
 * transport fails to come up. The original startup error remains observable;
 * rollback failures are bounded logs because they cannot safely supersede it.
 */
async function startWinnerTransport(context: ReconcileContext): Promise<void> {
  const { family, input, platform, ports } = context;
  try {
    await input.startTransport(platform, family.winnerName);
  } catch (error) {
    const clientId = ports[platform].clientId(family.winnerName);
    await rollbackFailedWinnerStart(context, clientId, 'teardown', () =>
      input.teardownTransport(platform, family.winnerName),
    );
    await rollbackFailedWinnerStart(context, clientId, 'unregister', () => {
      input.unregisterTransport(platform, clientId);
    });
    await rollbackFailedWinnerStart(context, clientId, 'disable', () =>
      ports[platform].setEnabled(family.winnerName, false),
    );
    throw error;
  }
}

async function rollbackFailedWinnerStart(
  context: ReconcileContext,
  clientId: string,
  step: 'teardown' | 'unregister' | 'disable',
  action: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await action();
  } catch {
    logger.error(
      {
        platform: context.platform,
        outcome: 'conflict',
        canonical_agent: context.family.canonicalName,
        winner_agent: context.family.winnerName,
        client_id: clientId,
        reason: 'winner_start_rollback_failed',
        rollback_step: step,
      },
      RECONCILE_EVENT,
    );
  }
}
