import type { SkillEntry, SkillSourceKind } from '@mavis/skills';
import {
  SkillScope,
  SkillSourceType,
  type SkillInfo,
} from '@mavis/protocol/local';

import { frontmatterString } from './registry-family.js';
import type { InstalledSkillHubMetadata } from './registry-operations.js';

const INSTALLED_SKILL_HUB_SOURCE_KIND = 'skill-hub-local';

/**
 * Registry view mapping + list-paging helpers split out of
 * `registry-operations.ts` to keep it inside the local-runtime layout budget.
 * Pure projection only: no registry IO lives here.
 */

export function toSkillInfo(
  entry: SkillEntry,
  installedHubMetadata?: InstalledSkillHubMetadata,
  enabled = true,
): SkillInfo {
  // Hub installs keep Market presentation metadata in skill-hub.json. Other
  // skills use an explicit frontmatter title, then let the UI fall back to name.
  // Do not use entry.title because it also falls back to the markdown heading.
  const explicitTitle = frontmatterString(entry.frontmatter.title);
  const displayName = installedHubMetadata?.displayName ?? explicitTitle;
  const info: SkillInfo & {
    sourceKind?: string;
    publisherSourceType?: SkillSourceType;
    displayNames?: typeof entry.displayNames;
    descriptions?: typeof entry.descriptions;
  } = {
    name: entry.name,
    ...(displayName ? { displayName } : {}),
    ...(installedHubMetadata?.creatorInfo ? { creatorInfo: installedHubMetadata.creatorInfo } : {}),
    ...(installedHubMetadata?.publisherSourceType !== undefined
      ? { publisherSourceType: installedHubMetadata.publisherSourceType }
      : {}),
    description: entry.description,
    displayDescription: entry.description,
    scope: toSkillScope(entry.rootKind),
    sourceType: toSkillSourceType(entry.rootKind),
    sourceKind:
      installedHubMetadata !== undefined
        ? INSTALLED_SKILL_HUB_SOURCE_KIND
        : toSourceKind(entry.rootKind, entry.rootScope),
    ...(entry.displayNames ? { displayNames: entry.displayNames } : {}),
    ...(entry.descriptions ? { descriptions: entry.descriptions } : {}),
    ...(entry.rootKind === 'agent' && entry.rootScope ? { agentName: entry.rootScope } : {}),
    updatedAt: Math.trunc(entry.mtimeMs),
    locationUri: entry.locationUri,
    enabled,
  };
  return info;
}

// Fine-grained physical source string consumed by the UI's
// `isLocalizableBuiltinSkill` gate. Builtin skills split by owning agent:
//   builtin + owning agent -> builtin-agent
//   builtin + no agent     -> builtin-global
// Non-builtin kinds surface their registry kind verbatim, except installed
// Skill Hub copies. Those share the global filesystem root with locally
// created Skills, so their persisted install identity supplies a distinct
// physical source marker for the Personal author projection.
export function toSourceKind(kind: SkillSourceKind, rootScope?: string): string {
  if (kind === 'builtin') {
    return rootScope ? 'builtin-agent' : 'builtin-global';
  }
  return kind;
}

export function toSkillScope(kind: SkillSourceKind): SkillScope {
  switch (kind) {
    case 'agent':
      return SkillScope.AGENT;
    case 'builtin':
    case 'project':
    case 'workspace':
    case 'global':
    case 'user':
      return SkillScope.GLOBAL;
  }
}

export function toSkillSourceType(kind: SkillSourceKind): SkillSourceType {
  return kind === 'builtin' ? SkillSourceType.MINIMAX_OFFICIAL : SkillSourceType.USER_CONTRIBUTION;
}

export function parseCursor(cursor: string | undefined): number {
  const value = Number(cursor ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function normalizeLimit(limit: number | undefined): number {
  if (!Number.isInteger(limit) || limit === undefined || limit <= 0) return 50;
  return Math.min(limit, 200);
}

export function normalizeOptionalNumber(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
