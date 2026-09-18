import { type SkillEntry, type SkillRegistry, type SkillViewEntry } from '@mavis/skills';

import { isLocalBuiltinSkillEnabled } from './builtin.js';
import {
  emitResourceAmbiguityTelemetry,
  type SubagentTelemetryHost,
} from '../agent/subagent-telemetry.js';

const DEFAULT_LOCAL_AGENT_NAME = 'mavis';

/** Contract-level resolution failure without adding fields to DesktopService. */
export class LocalSkillResolutionError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'LocalSkillResolutionError';
  }
}

export function filterSkillsVisibleToAgent<T extends SkillEntry>(
  entries: T[],
  options: { agentName?: string; compatibleAgentNames?: readonly string[] } = {},
): T[] {
  const visibleAgentNames = new Set([
    options.agentName || DEFAULT_LOCAL_AGENT_NAME,
    ...(options.compatibleAgentNames ?? []),
  ]);
  return entries.filter(
    (entry) =>
      isVisibleLocalSkill(entry) && (!entry.rootScope || visibleAgentNames.has(entry.rootScope)),
  );
}

export function isEntryVisibleToAgent(
  entry: SkillEntry,
  options: { agentName?: string; compatibleAgentNames?: readonly string[] },
): boolean {
  const visibleAgentNames = new Set([
    options.agentName || DEFAULT_LOCAL_AGENT_NAME,
    ...(options.compatibleAgentNames ?? []),
  ]);
  return !entry.rootScope || visibleAgentNames.has(entry.rootScope);
}

export function getManagementEntries(
  registry: SkillRegistry,
  options: { agentName?: string; compatibleAgentNames?: readonly string[] },
): SkillEntry[] {
  // Keep the management projection compatible with lightweight registry
  // doubles used by callers/tests that only expose the stable read API.
  const snapshot = registry.getSnapshot?.();
  if (!snapshot) return registry.getAvailableSkills();
  const winners = filterSkillsVisibleToAgent(snapshot.winners, options);
  const namesToExpose = ambiguousLegacySkillNames(registry, options);
  if (namesToExpose.size === 0) return winners;

  const existing = new Set(winners.map((entry) => entry.locationUri));
  const legacyEntries = snapshot.entries.filter(
    (entry) =>
      namesToExpose.has(entry.name) &&
      entry.rootKind === 'agent' &&
      isEntryVisibleToAgent(entry, options) &&
      !existing.has(entry.locationUri),
  );
  return [...winners, ...legacyEntries];
}

export function ambiguousLegacySkillNames(
  registry: SkillRegistry,
  options: { agentName?: string; compatibleAgentNames?: readonly string[] },
): ReadonlySet<string> {
  const snapshot = registry.getSnapshot?.();
  if (!snapshot) return new Set();
  const canonical = options.agentName || DEFAULT_LOCAL_AGENT_NAME;
  const names = new Set([canonical, ...(options.compatibleAgentNames ?? [])]);
  const byName = new Map<string, Set<string>>();
  for (const entry of snapshot.entries) {
    if (
      entry.rootKind !== 'agent' ||
      !entry.rootScope ||
      entry.rootScope === canonical ||
      !names.has(entry.rootScope)
    ) {
      continue;
    }
    const sources = byName.get(entry.name) ?? new Set<string>();
    sources.add(entry.rootScope);
    byName.set(entry.name, sources);
  }
  const canonicalNames = new Set(
    snapshot.entries
      .filter((entry) => entry.rootKind === 'agent' && entry.rootScope === canonical)
      .map((entry) => entry.name),
  );
  return new Set(
    [...byName.entries()]
      .filter(([name, sources]) => sources.size > 1 && !canonicalNames.has(name))
      .map(([name]) => name),
  );
}

export function ambiguousLegacyLocations(
  registry: SkillRegistry,
  name: string,
  options: { agentName?: string; compatibleAgentNames?: readonly string[] },
): string[] {
  const snapshot = registry.getSnapshot?.();
  if (!snapshot) return [];
  const canonical = options.agentName || DEFAULT_LOCAL_AGENT_NAME;
  const names = new Set([canonical, ...(options.compatibleAgentNames ?? [])]);
  return snapshot.entries
    .filter(
      (entry) =>
        entry.name === name &&
        entry.rootKind === 'agent' &&
        entry.rootScope !== canonical &&
        Boolean(entry.rootScope) &&
        names.has(entry.rootScope!),
    )
    .map((entry) => entry.locationUri)
    .sort();
}

export function ambiguousSkillNameError(
  name: string,
  locations: readonly string[],
  telemetryHost?: SubagentTelemetryHost,
): LocalSkillResolutionError {
  emitResourceAmbiguityTelemetry(telemetryHost, 'skill', new Set(locations).size);
  return new LocalSkillResolutionError(
    409,
    `Skill name "${name}" is ambiguous; use location_uri`,
    'AMBIGUOUS_SKILL_NAME',
    { name, locations },
  );
}

export function readShippedBuiltinSkillNames(registry: SkillRegistry): ReadonlySet<string> {
  const snapshot = registry.getSnapshot?.();
  return new Set(
    snapshot?.entries.filter((entry) => entry.rootKind === 'builtin').map((entry) => entry.name) ??
      [],
  );
}

export function isBuiltinSkillInjectable(
  registry: SkillRegistry,
  entry: SkillEntry,
  injectableBuiltinSkillNames: ReadonlySet<string> | undefined,
): boolean {
  if (!injectableBuiltinSkillNames) return true;
  const shippedBuiltinNames = readShippedBuiltinSkillNames(registry);
  // A user/global collision remains an ordinary user skill. Agent-user
  // compatibility roots are the only legacy path that could bypass the role
  // ceiling and therefore share the shipped-name gate.
  return (
    !shippedBuiltinNames.has(entry.name) ||
    (entry.rootKind !== 'builtin' && entry.rootKind !== 'agent') ||
    injectableBuiltinSkillNames.has(entry.name)
  );
}

export function isVisibleLocalSkill(entry: SkillEntry): boolean {
  return entry.rootKind !== 'builtin' || isLocalBuiltinSkillEnabled(entry.name);
}

export function isSkillAllowedByBetaFlags(
  entry: SkillEntry,
  betaFlags: Readonly<Record<string, boolean | undefined>> = {},
): boolean {
  const requiresBeta =
    frontmatterString(entry.frontmatter.requiresBeta) ??
    frontmatterString(entry.frontmatter.requires_beta);
  return !requiresBeta || betaFlags[requiresBeta] === true;
}

export function filterInjectableRegistrySkills(
  entries: SkillViewEntry[],
  options: {
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    builtinSkillNames?: ReadonlySet<string>;
    ambiguousSkillNames?: ReadonlySet<string>;
    betaFlags?: Readonly<Record<string, boolean | undefined>>;
    injectableBuiltinSkillNames?: ReadonlySet<string>;
    mcpServerNames?: ReadonlySet<string>;
    /** Canonical selector for all standalone Skills; the ready inventory is still the upper bound. */
    allowedSkillNames?: ReadonlySet<string>;
    /** Split-bucket Agent/global/workspace Skill selector. */
    allowedExtensionSkillNames?: ReadonlySet<string>;
  } = {},
): SkillViewEntry[] {
  const betaFlags = options.betaFlags ?? {};
  const builtinSkillNames = options.builtinSkillNames ?? new Set<string>();
  return filterSkillsVisibleToAgent(entries, options)
    .filter((entry) => !options.ambiguousSkillNames?.has(entry.name))
    .filter((entry) => entry.frontmatter.listed !== false)
    .filter(
      (entry) =>
        !entry.name.startsWith('mcp-') || !options.mcpServerNames?.has(entry.name.slice(4)),
    )
    .filter((entry) => options.allowedSkillNames?.has(normalizeSkillSelectorName(entry.name)) ?? true)
    .filter(
      (entry) =>
        entry.rootKind === 'builtin' ||
        (options.allowedExtensionSkillNames?.has(normalizeSkillSelectorName(entry.name)) ?? true),
    )
    .filter((entry) => {
      if (!options.injectableBuiltinSkillNames) return true;
      return (
        !builtinSkillNames.has(entry.name) ||
        (entry.rootKind !== 'builtin' && entry.rootKind !== 'agent') ||
        options.injectableBuiltinSkillNames.has(entry.name)
      );
    })
    .filter((entry) => isSkillAllowedByBetaFlags(entry, betaFlags));
}

export function normalizeSkillSelectorName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function toNormalizedSkillSelectorSet(
  values: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  return values === undefined
    ? undefined
    : new Set(values.map(normalizeSkillSelectorName).filter(Boolean));
}

export function frontmatterString(
  value: string | number | boolean | undefined,
): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
