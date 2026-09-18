import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkillRegistry, type SkillEntry, type SkillSourceKind } from '@mavis/skills';
import {
  type CreatorInfo,
  type SkillFileInfo,
  type SkillInfo,
  type SkillSourceType,
} from '@mavis/protocol/local';

import type { LocalRuntimeConfig } from '../config/types.js';
import type { SubagentTelemetryHost } from '../agent/subagent-telemetry.js';
import { resolveDataDirVariables } from '../utils/data-dir-variables.js';
import { getBuiltinAgentsDirCandidates } from './builtin.js';
import {
  normalizeLimit,
  normalizeOptionalNumber,
  parseCursor,
  toSkillInfo,
} from './registry-views.js';
import {
  renderLocalSkillsCatalogResult,
  type LocalSkillCatalogTokenEstimator,
  type LocalSkillsCatalogEntry,
  type LocalSkillsCatalogRenderResult,
} from './catalog.js';
import {
  ambiguousLegacyLocations,
  ambiguousLegacySkillNames,
  ambiguousSkillNameError,
  filterInjectableRegistrySkills,
  filterSkillsVisibleToAgent,
  getManagementEntries,
  isSkillAllowedByBetaFlags,
  isVisibleLocalSkill,
  LocalSkillResolutionError,
  readShippedBuiltinSkillNames,
} from './registry-family.js';

export interface InstalledSkillHubMetadata {
  displayName?: string;
  creatorInfo?: CreatorInfo;
  publisherSourceType?: SkillSourceType;
}

export function listRegistrySkillSummaries(
  registry: SkillRegistry,
  options: {
    limit?: number;
    cursor?: string;
    scope?: number | string;
    sourceType?: number | string;
    keyword?: string;
    excludeBuiltin?: boolean;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    installedHubMetadataByLocationUri?: ReadonlyMap<string, InstalledSkillHubMetadata>;
    disabledLocationUris?: ReadonlySet<string>;
    betaFlags?: Readonly<Record<string, boolean | undefined>>;
  },
): { skills: SkillInfo[]; hasMore: boolean; nextCursor?: string } {
  const offset = parseCursor(options.cursor);
  const limit = normalizeLimit(options.limit);
  const scope = normalizeOptionalNumber(options.scope);
  const sourceType = normalizeOptionalNumber(options.sourceType);
  const keyword = options.keyword?.trim().toLowerCase();
  const filtered = getManagementEntries(registry, options)
    .filter((entry) => isVisibleLocalSkill(entry))
    .filter((entry) => isSkillAllowedByBetaFlags(entry, options.betaFlags))
    .filter((entry) => !options.excludeBuiltin || entry.rootKind !== 'builtin')
    .map((entry) =>
      toSkillInfo(
        entry,
        options.installedHubMetadataByLocationUri?.get(entry.locationUri),
        !options.disabledLocationUris?.has(entry.locationUri),
      ),
    )
    .filter((skill) => scope === undefined || skill.scope === scope)
    .filter((skill) => sourceType === undefined || skill.sourceType === sourceType)
    .filter(
      (skill) =>
        !keyword ||
        [skill.name, skill.displayName, skill.description, skill.displayDescription].some((value) =>
          value?.toLowerCase().includes(keyword),
        ),
    );
  // Match the card label shown by "My skills" before cursor pagination. The
  // internal name provides a stable tiebreak when multiple cards share a label.
  // The shared registry ordering (used for prompt catalogs) remains untouched.
  filtered.sort((left, right) => {
    const labelOrder = (left.displayName || left.name).localeCompare(
      right.displayName || right.name,
    );
    return labelOrder !== 0 ? labelOrder : left.name.localeCompare(right.name);
  });
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < filtered.length;
  return {
    skills: page,
    hasMore,
    ...(hasMore ? { nextCursor: String(nextOffset) } : {}),
  };
}

export function getRegistrySkillDetail(
  registry: SkillRegistry,
  input: {
    skillName: string;
    locationUri?: string;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  },
  options: { includeBody?: boolean; disabledLocationUris?: ReadonlySet<string> } = {},
): { skill: SkillInfo; content?: string } | undefined {
  const entry = findMatchingSkillEntry(registry, input);
  if (!entry) return undefined;
  return {
    skill: toSkillInfo(entry, undefined, !options.disabledLocationUris?.has(entry.locationUri)),
    ...(options.includeBody ? { content: entry.content } : {}),
  };
}

export async function listRegistrySkillFiles(
  registry: SkillRegistry,
  input: {
    skillName: string;
    locationUri?: string;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  },
): Promise<SkillFileInfo[] | undefined> {
  const entry = findMatchingSkillEntry(registry, input);
  return entry ? listSkillFilesFromDir(entry.skillDir) : undefined;
}

export async function readRegistrySkillFile(
  registry: SkillRegistry,
  input: {
    skillName: string;
    path: string;
    locationUri?: string;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  },
): Promise<string | undefined> {
  const entry = findMatchingSkillEntry(registry, input);
  // Distinguish "file missing / outside the skill dir" (raw === undefined,
  // surfaced as 404 upstream) from "file present but empty" (raw === '').
  // `raw` is the result of `fs.readFile` after a `.catch(() => undefined)`,
  // so the only non-undefined value when the file is reachable is a string
  // — possibly the empty string. Truthiness-check would collapse both cases
  // into 404, so check for undefined explicitly.
  const raw = entry ? await readFileFromSkillDir(entry.skillDir, input.path) : undefined;
  return raw === undefined ? undefined : resolveDataDirVariables(raw);
}

export async function deleteRegistrySkill(
  registry: SkillRegistry,
  input: {
    skillName: string;
    locationUri?: string;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  },
): Promise<{ ok: true; name: string } | 'protected' | undefined> {
  if (input.agentName && !input.locationUri) {
    throw new LocalSkillResolutionError(
      400,
      'Skill deletion requires an exact location for agent-scoped skills',
      'SKILL_LOCATION_REQUIRED',
    );
  }
  const entry = findMatchingSkillEntry(registry, input);
  if (!entry) return undefined;
  if (entry.rootKind === 'builtin') return 'protected';
  await rm(entry.entryDir ?? entry.skillDir, { recursive: true, force: true });
  return { ok: true, name: entry.name };
}

export function listRegistryRuntimeSkills(
  registry: SkillRegistry,
  options: {
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    betaFlags?: Readonly<Record<string, boolean | undefined>>;
    injectableBuiltinSkillNames?: ReadonlySet<string>;
    allowedSkillNames?: ReadonlySet<string>;
    allowedExtensionSkillNames?: ReadonlySet<string>;
    mcpServerNames?: ReadonlySet<string>;
    disabledLocationUris?: ReadonlySet<string>;
  } = {},
): { skills: SkillInfo[]; refreshedAt: number } {
  const snapshot = registry.getSnapshot?.();
  const entries = filterInjectableRegistrySkills(registry.getAvailableSkills(), {
    agentName: options.agentName,
    compatibleAgentNames: options.compatibleAgentNames,
    builtinSkillNames: readShippedBuiltinSkillNames(registry),
    ambiguousSkillNames: ambiguousLegacySkillNames(registry, options),
    betaFlags: options.betaFlags,
    injectableBuiltinSkillNames: options.injectableBuiltinSkillNames,
    allowedSkillNames: options.allowedSkillNames,
    allowedExtensionSkillNames: options.allowedExtensionSkillNames,
    mcpServerNames: options.mcpServerNames,
    // `filterInjectableRegistrySkills` (registry-family) has no disabled-location
    // awareness, so keep preview_train's disabled-skill-location gate here.
  }).filter((entry) => !options.disabledLocationUris?.has(entry.locationUri));
  const skills = entries.map((entry) => toSkillInfo(entry));
  return {
    skills,
    refreshedAt: snapshot?.generatedAt ?? Date.now(),
  };
}

export function renderLocalRegistrySkillsCatalog(
  registry: SkillRegistry,
  options: {
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    injectableBuiltinSkillNames?: ReadonlySet<string>;
    allowedSkillNames?: ReadonlySet<string>;
    allowedExtensionSkillNames?: ReadonlySet<string>;
    betaFlags?: Readonly<Record<string, boolean | undefined>>;
    mcpServerNames?: ReadonlySet<string>;
    disabledLocationUris?: ReadonlySet<string>;
    contextWindowTokens?: number;
    tokenEstimator?: LocalSkillCatalogTokenEstimator;
    additionalSkills?: readonly LocalSkillsCatalogEntry[];
  } = {},
): LocalSkillsCatalogRenderResult {
  const entries = filterInjectableRegistrySkills(registry.getAvailableSkills(), {
    agentName: options.agentName,
    compatibleAgentNames: options.compatibleAgentNames,
    builtinSkillNames: readShippedBuiltinSkillNames(registry),
    ambiguousSkillNames: ambiguousLegacySkillNames(registry, options),
    betaFlags: options.betaFlags,
    injectableBuiltinSkillNames: options.injectableBuiltinSkillNames,
    allowedSkillNames: options.allowedSkillNames,
    allowedExtensionSkillNames: options.allowedExtensionSkillNames,
    mcpServerNames: options.mcpServerNames,
    // `filterInjectableRegistrySkills` (registry-family) has no disabled-location
    // awareness, so keep preview_train's disabled-skill-location gate here.
  }).filter((entry) => !options.disabledLocationUris?.has(entry.locationUri));
  // DesktopService registry entries and legacy builtin skill entries must render
  // the same <available_skills> shape; otherwise the clean local-runtime prompt
  // drifts depending on which skill source populated the catalog.
  return renderLocalSkillsCatalogResult(
    [
      ...entries.map((entry) => ({
        name: entry.name,
        description: entry.description,
        builtin: entry.rootKind === 'builtin',
      })),
      ...(options.additionalSkills ?? []),
    ],
    {
      contextWindowTokens: options.contextWindowTokens,
      tokenEstimator: options.tokenEstimator,
    },
  );
}

export function readRegistrySkillByName(
  registry: SkillRegistry,
  name: string,
  options: {
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    disabledLocationUris?: ReadonlySet<string>;
    betaFlags?: Readonly<Record<string, boolean | undefined>>;
    injectableBuiltinSkillNames?: ReadonlySet<string>;
    allowedSkillNames?: ReadonlySet<string>;
    allowedExtensionSkillNames?: ReadonlySet<string>;
    mcpServerNames?: ReadonlySet<string>;
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  } = {},
): { content: string; locationUri: string; sourceKind: SkillSourceKind } | undefined {
  const ambiguous = ambiguousLegacySkillNames(registry, options);
  const entry = filterInjectableRegistrySkills(registry.getAvailableSkills(), {
    agentName: options.agentName,
    compatibleAgentNames: options.compatibleAgentNames,
    builtinSkillNames: readShippedBuiltinSkillNames(registry),
    betaFlags: options.betaFlags,
    injectableBuiltinSkillNames: options.injectableBuiltinSkillNames,
    allowedSkillNames: options.allowedSkillNames,
    allowedExtensionSkillNames: options.allowedExtensionSkillNames,
    mcpServerNames: options.mcpServerNames,
  }).find((candidate) => candidate.name === name);
  if (!entry || options.disabledLocationUris?.has(entry.locationUri)) return undefined;
  if (ambiguous.has(name)) {
    throw ambiguousSkillNameError(
      name,
      ambiguousLegacyLocations(registry, name, options),
      options.resourceAmbiguityTelemetry,
    );
  }
  return { content: entry.content, locationUri: entry.locationUri, sourceKind: entry.rootKind };
}

export function hasRegistryLocationUri(registry: SkillRegistry, locationUri: string): boolean {
  try {
    registry.getByLocationUri(locationUri);
    return true;
  } catch {
    return false;
  }
}

export function resolveRegistrySkillIdentity(
  registry: SkillRegistry,
  input: { skillName: string; locationUri?: string; agentName?: string },
): { name: string; locationUri: string; protected: boolean } | undefined {
  const entry = findMatchingSkillEntry(registry, input);
  return entry
    ? { name: entry.name, locationUri: entry.locationUri, protected: entry.rootKind === 'builtin' }
    : undefined;
}

export async function inferAgentNameFromConfiguredLocationUri(
  config: LocalRuntimeConfig,
  locationUri: string,
): Promise<string | undefined> {
  const fileLocation = filePathFromLocationUri(locationUri);
  if (!fileLocation) return undefined;
  const agentsDirs = [join(config.dataDir, 'agents'), ...getBuiltinAgentsDirCandidates()];
  for (const agentsDir of agentsDirs) {
    const agentName = await inferAgentNameFromAgentsDir(agentsDir, fileLocation);
    if (agentName) return agentName;
  }
  return undefined;
}

function findSkillEntry(
  registry: SkillRegistry,
  input: {
    skillName: string;
    locationUri?: string;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  },
): SkillEntry | undefined {
  if (input.locationUri) {
    try {
      const entry = registry.getByLocationUri(input.locationUri);
      return isVisibleLocalSkill(entry) ? entry : undefined;
    } catch {
      return undefined;
    }
  }
  const options = {
    agentName: input.agentName,
    compatibleAgentNames: input.compatibleAgentNames,
    resourceAmbiguityTelemetry: input.resourceAmbiguityTelemetry,
  };
  const ambiguous = ambiguousLegacySkillNames(registry, options);
  if (ambiguous.has(input.skillName)) {
    throw ambiguousSkillNameError(
      input.skillName,
      ambiguousLegacyLocations(registry, input.skillName, options),
      input.resourceAmbiguityTelemetry,
    );
  }
  return filterSkillsVisibleToAgent(registry.getAvailableSkills(), options).find(
    (entry) => entry.name === input.skillName,
  );
}

function findMatchingSkillEntry(
  registry: SkillRegistry,
  input: {
    skillName: string;
    locationUri?: string;
    agentName?: string;
    compatibleAgentNames?: readonly string[];
    resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  },
): SkillEntry | undefined {
  if (!input.locationUri) {
    const matches = filterSkillsVisibleToAgent(registry.getSnapshot()?.entries ?? [], {
      agentName: input.agentName,
      compatibleAgentNames: input.compatibleAgentNames,
    }).filter((entry) => entry.name === input.skillName);
    return matches.length === 1 ? matches[0] : undefined;
  }
  const entry = findSkillEntry(registry, input);
  return entry?.name === input.skillName ? entry : undefined;
}

async function listSkillFilesFromDir(baseDir: string, relativeDir = ''): Promise<SkillFileInfo[]> {
  const absoluteDir = relativeDir ? join(baseDir, relativeDir) : baseDir;
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
      .map(async (entry) => {
        const path = relativeDir ? join(relativeDir, entry.name) : entry.name;
        const file: SkillFileInfo = { name: entry.name, path, isDir: entry.isDirectory() };
        return entry.isDirectory()
          ? [file, ...(await listSkillFilesFromDir(baseDir, path))]
          : [file];
      }),
  );
  return nested.flat();
}

async function readFileFromSkillDir(
  baseDir: string,
  filePath: string,
): Promise<string | undefined> {
  const resolvedFile = await resolveFileInsideSkillDir(baseDir, filePath);
  return resolvedFile ? readFile(resolvedFile, 'utf8').catch(() => undefined) : undefined;
}

async function resolveFileInsideSkillDir(
  baseDir: string,
  filePath: string,
): Promise<string | undefined> {
  const base = await canonicalExistingPath(baseDir);
  const resolvedFile = resolve(base, filePath);
  if (!isPathInside(base, resolvedFile)) return undefined;
  const fileStat = await stat(resolvedFile).catch(() => undefined);
  if (!fileStat?.isFile()) return undefined;
  const realFile = await realpath(resolvedFile).catch(() => undefined);
  return realFile && isPathInside(base, realFile) ? realFile : undefined;
}

function isPathInside(base: string, target: string): boolean {
  const relativePath = relative(base, target);
  return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

async function inferAgentNameFromAgentsDir(
  agentsDir: string,
  fileLocation: string,
): Promise<string | undefined> {
  const canonicalAgentsDir = await canonicalExistingPath(agentsDir);
  const relativePath = relative(canonicalAgentsDir, fileLocation);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined;
  const [agentName, skillsSegment] = relativePath.split(/[\\/]+/);
  return agentName && skillsSegment === 'skills' ? agentName : undefined;
}

async function canonicalExistingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function filePathFromLocationUri(locationUri: string): string | undefined {
  if (!locationUri.startsWith('files://')) return undefined;
  try {
    return fileURLToPath(locationUri.replace(/^files:/u, 'file:'));
  } catch {
    return undefined;
  }
}
