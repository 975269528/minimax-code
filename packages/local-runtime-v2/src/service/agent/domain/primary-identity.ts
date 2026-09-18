import { AgentServiceError } from '../errors.js';
import { LEGACY_PRIMARY_AGENT_NAME } from './names.js';
import type { AgentStoreConfig, AgentStoreIdentity, AgentStoreMeta } from '../contracts.js';

/**
 * Primary family identity contract.
 *
 * `storageOwnerName` is the persisted Session/history/ledger owner and stays
 * `main` on upgraded installs. `executionOwnerName` is the single behaviour
 * source (persona, profile, identity, config, capability ceiling, skill policy)
 * and is pinned to the canonical row once it is seeded.
 */
export type PrimaryExecutionOutcome = 'canonical' | 'legacy_fallback' | 'conflict';

export interface PrimaryExecutionIdentity {
  readonly storageOwnerName: string;
  readonly executionOwnerName: string;
  readonly outcome: PrimaryExecutionOutcome;
}

/** Minimal trusted-builtin projection of a persisted primary family row. */
export interface PrimaryFamilyMember {
  readonly name: string;
  readonly trustedBuiltin: boolean;
}

function primaryFamilyNames(primaryAgentName: string): readonly string[] {
  return primaryAgentName === LEGACY_PRIMARY_AGENT_NAME
    ? [primaryAgentName]
    : [primaryAgentName, LEGACY_PRIMARY_AGENT_NAME];
}

export function isPrimaryFamilyName(name: string, primaryAgentName: string): boolean {
  return primaryFamilyNames(primaryAgentName).includes(name);
}

export function toPrimaryFamilyMembers(
  metas: readonly AgentStoreMeta[],
  primaryAgentName: string,
  isTrustedBuiltin: (meta: AgentStoreMeta) => boolean,
): readonly PrimaryFamilyMember[] {
  return primaryFamilyNames(primaryAgentName).flatMap((name) => {
    const meta = metas.find((candidate) => candidate.name === name);
    return meta ? [{ name, trustedBuiltin: isTrustedBuiltin(meta) }] : [];
  });
}

function primaryAgentIdentityConflictError(occupiedNames: readonly string[]): AgentServiceError {
  return new AgentServiceError(
    'PRIMARY_AGENT_IDENTITY_CONFLICT',
    `Reserved primary Agent name is occupied by a non-builtin Agent: ${[...occupiedNames]
      .sort()
      .join(', ')}`,
    undefined,
    { candidates: [...occupiedNames].sort() },
  );
}

export function legacyPrimaryWriteForbiddenError(
  requestedName: string,
  canonicalName: string,
): AgentServiceError {
  return new AgentServiceError(
    'LEGACY_PRIMARY_WRITE_FORBIDDEN',
    `Legacy primary Agent "${requestedName}" is read-only history; write to "${canonicalName}" instead.`,
    undefined,
    { requestedName, canonicalName },
  );
}

/**
 * Fail closed when a caller observes an untrusted primary row before the
 * startup provenance repair has adopted the historical built-in identity.
 */
export function assertTrustedPrimaryFamily(members: readonly PrimaryFamilyMember[]): void {
  const occupied = members.filter((member) => !member.trustedBuiltin).map((member) => member.name);
  if (occupied.length > 0) throw primaryAgentIdentityConflictError(occupied);
}

/**
 * Resolves the frozen execution owner for a persisted storage owner. Returns
 * `undefined` for every Agent outside the primary family so ordinary Agents
 * keep using their own persisted row.
 */
export function resolvePrimaryExecutionIdentity(input: {
  readonly storageOwnerName: string;
  readonly primaryAgentName: string;
  readonly members: readonly PrimaryFamilyMember[];
}): PrimaryExecutionIdentity | undefined {
  const { storageOwnerName, primaryAgentName, members } = input;
  if (!isPrimaryFamilyName(storageOwnerName, primaryAgentName)) return undefined;
  assertTrustedPrimaryFamily(members);
  const canonical = members.find((member) => member.name === primaryAgentName);
  if (canonical) {
    return { storageOwnerName, executionOwnerName: canonical.name, outcome: 'canonical' };
  }
  // Standalone V1 compatibility: no canonical row was ever seeded, so the
  // trusted legacy row is view, storage and execution owner at the same time.
  const legacy = members.find((member) => member.name === LEGACY_PRIMARY_AGENT_NAME);
  if (legacy) {
    return { storageOwnerName, executionOwnerName: legacy.name, outcome: 'legacy_fallback' };
  }
  return undefined;
}

export interface LegacyProfileOverlayPlan {
  readonly displayName?: string;
  readonly description?: string;
  readonly avatar?: string;
  readonly defaultWorkspaceDir?: string;
}

export interface LegacyProfileOverlayInput {
  readonly canonicalIdentity: AgentStoreIdentity | null;
  readonly canonicalConfig: AgentStoreConfig | null;
  readonly legacyIdentity: AgentStoreIdentity | null;
  readonly legacyConfig: AgentStoreConfig | null;
  /** Package seed identity for the canonical row; equal values count as unset. */
  readonly seedIdentity: AgentStoreIdentity;
  /** Product-locked primary display name never adopts a legacy value. */
  readonly primaryDisplayNameLocked: boolean;
}

/**
 * One idempotent convergence pass: adopt the legacy row's user-authored profile
 * only while the canonical row is still empty or still equal to the package
 * seed. Persona / system prompt stay on the Mavis builtin package, and
 * Owner / ACL are deliberately out of scope here.
 */
export function planLegacyProfileOverlay(
  input: LegacyProfileOverlayInput,
): LegacyProfileOverlayPlan | undefined {
  const plan: LegacyProfileOverlayPlan = {
    ...(input.primaryDisplayNameLocked
      ? {}
      : overlayField(
          'displayName',
          input.canonicalIdentity?.displayName,
          input.legacyIdentity?.displayName,
          input.seedIdentity.displayName,
        )),
    ...overlayField(
      'description',
      input.canonicalIdentity?.description,
      input.legacyIdentity?.description,
      input.seedIdentity.description,
    ),
    ...overlayField(
      'avatar',
      input.canonicalIdentity?.avatar,
      input.legacyIdentity?.avatar,
      input.seedIdentity.avatar,
    ),
    ...overlayField(
      'defaultWorkspaceDir',
      input.canonicalConfig?.defaultWorkspaceDir,
      input.legacyConfig?.defaultWorkspaceDir,
      undefined,
    ),
  };
  return Object.keys(plan).length === 0 ? undefined : plan;
}

function overlayField(
  field: keyof LegacyProfileOverlayPlan,
  canonicalValue: string | undefined,
  legacyValue: string | undefined,
  seedDefault: string | undefined,
): Partial<Record<keyof LegacyProfileOverlayPlan, string>> {
  const legacy = legacyValue?.trim();
  const seed = seedDefault?.trim() ?? '';
  if (!legacy || legacy === seed) return {};
  const canonical = canonicalValue?.trim() ?? '';
  // A canonical value the user already changed always wins; the legacy row
  // stays as read-only history.
  if (canonical !== '' && canonical !== seed) return {};
  return { [field]: legacy };
}
