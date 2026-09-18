import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimeRegion } from '@mavis/config';
import yaml from 'js-yaml';
import { renderLocalSkillsCatalog } from './catalog.js';

const SKILL_FILE = 'SKILL.md';
const BUILTIN_SCOPE = 5;
const BUILTIN_SOURCE_TYPE = 1;
const BUILTIN_GLOBAL_SOURCE_KIND = 'builtin-global';
const BUILTIN_AGENT_SOURCE_KIND = 'builtin-agent';
const LEGACY_PRIMARY_AGENT_NAME = 'main';
const PRIMARY_AGENT_NAME = 'mavis';
const CN_DISABLED_BUILTIN_SKILLS: ReadonlySet<string> = new Set(['x-link-reader']);

export function isLocalBuiltinSkillEnabled(name: string): boolean {
  return getRuntimeRegion() !== 'cn' || !CN_DISABLED_BUILTIN_SKILLS.has(name);
}

export interface LocalBuiltinSkillInfo {
  name: string;
  description: string;
  display_name?: string;
  scope: number;
  location: string;
  source_type: number;
  source_kind: string;
  requires_beta?: string;
  agent_name?: string;
}

type LocalSkillPromptInfo = Pick<LocalBuiltinSkillInfo, 'name' | 'description'> & {
  source_kind?: unknown;
};

export interface LocalBuiltinSkillFileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: LocalBuiltinSkillFileNode[];
}

let cachedGlobalSkills: LocalBuiltinSkillInfo[] | undefined;
let cachedAgentSkills: Map<string, LocalBuiltinSkillInfo[]> | undefined;

export function clearLocalBuiltinSkillCacheForTest(): void {
  cachedGlobalSkills = undefined;
  cachedAgentSkills = undefined;
}

export async function listLocalBuiltinSkills(): Promise<LocalBuiltinSkillInfo[]> {
  if (cachedGlobalSkills) return cachedGlobalSkills;

  const skillsDir = await resolveBuiltinSkillsDir();
  if (!skillsDir) {
    cachedGlobalSkills = [];
    return cachedGlobalSkills;
  }

  cachedGlobalSkills = await listBuiltinSkillsInDir(skillsDir, BUILTIN_GLOBAL_SOURCE_KIND);
  return cachedGlobalSkills;
}

export async function listLocalBuiltinSkillsForAgent(
  agentName: string,
): Promise<LocalBuiltinSkillInfo[]> {
  const [globalSkills, agentSkills] = await Promise.all([
    listLocalBuiltinSkills(),
    listLocalAgentBuiltinSkills(agentName),
  ]);
  if (agentSkills.length === 0) return globalSkills;

  const merged = new Map<string, LocalBuiltinSkillInfo>();
  for (const skill of globalSkills) merged.set(skill.name, skill);
  for (const skill of agentSkills) merged.set(skill.name, skill);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLocalAgentSpecificBuiltinSkills(
  agentName: string,
): Promise<LocalBuiltinSkillInfo[]> {
  return listLocalAgentBuiltinSkills(agentName);
}

export async function listLocalBuiltinSkillsForInjection(
  agentName: string,
  betaFlags: Readonly<Record<string, boolean | undefined>>,
): Promise<LocalBuiltinSkillInfo[]> {
  return filterLocalSkillsForInjection(await listLocalBuiltinSkillsForAgent(agentName), betaFlags);
}

export async function listLocalAgentSkillFallback(
  agentName: string,
  url: URL,
  betaFlags: Readonly<Record<string, boolean | undefined>>,
): Promise<LocalBuiltinSkillInfo[]> {
  const scope = readOptionalNumber(url.searchParams.get('scope'));
  const inject = readOptionalBoolean(url.searchParams.get('inject')) === true;
  const skills =
    scope === 1
      ? await listLocalAgentSpecificBuiltinSkills(agentName)
      : scope === 2
        ? await listLocalBuiltinSkills()
        : inject
          ? await listLocalBuiltinSkillsForInjection(agentName, betaFlags)
          : await listLocalBuiltinSkillsForAgent(agentName);
  return inject ? filterLocalSkillsForInjection(skills, betaFlags) : skills;
}

export function readLocalSkillAgentName(url: URL): string | undefined {
  return url.searchParams.get('agent_name') ?? url.searchParams.get('agentName') ?? undefined;
}

export async function readLocalBuiltinSkill(
  skillName: string,
  agentName?: string,
): Promise<(LocalBuiltinSkillInfo & { content: string }) | undefined> {
  const skill = await findLocalBuiltinSkill(skillName, agentName);
  if (!skill) return undefined;
  const content = await readFile(skill.location, 'utf8').catch(() => undefined);
  if (content === undefined) return undefined;
  return { ...skill, content };
}

export async function listLocalBuiltinSkillFiles(
  skillName: string,
  agentName?: string,
): Promise<LocalBuiltinSkillFileNode[] | undefined> {
  const skill = await findLocalBuiltinSkill(skillName, agentName);
  if (!skill) return undefined;
  return listSkillFilesFromDir(dirname(skill.location));
}

export async function readLocalBuiltinSkillFile(
  skillName: string,
  filePath: string,
  agentName?: string,
): Promise<string | undefined> {
  const skill = await findLocalBuiltinSkill(skillName, agentName);
  if (!skill) return undefined;
  const baseDir = dirname(skill.location);
  const resolvedBase = resolve(baseDir);
  const resolvedFile = resolve(baseDir, filePath);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(`${resolvedBase}${sep}`)) {
    return undefined;
  }
  const fileStat = await stat(resolvedFile).catch(() => undefined);
  if (!fileStat?.isFile()) return undefined;
  return readFile(resolvedFile, 'utf8').catch(() => undefined);
}

async function findLocalBuiltinSkill(
  skillName: string,
  agentName?: string,
): Promise<LocalBuiltinSkillInfo | undefined> {
  if (agentName) {
    return (await listLocalBuiltinSkillsForAgent(agentName)).find(
      (skill) => skill.name === skillName,
    );
  }
  const globalSkill = (await listLocalBuiltinSkills()).find((skill) => skill.name === skillName);
  if (globalSkill) return globalSkill;
  return (await listLocalBuiltinSkillsForAgent(PRIMARY_AGENT_NAME)).find(
    (skill) => skill.name === skillName,
  );
}

async function listLocalAgentBuiltinSkills(agentName: string): Promise<LocalBuiltinSkillInfo[]> {
  const normalizedAgentName = normalizeAgentName(agentName);
  cachedAgentSkills ??= new Map<string, LocalBuiltinSkillInfo[]>();
  const cached = cachedAgentSkills.get(normalizedAgentName);
  if (cached) return cached;

  const agentsDir = await resolveBuiltinAgentsDir();
  if (!agentsDir) {
    cachedAgentSkills.set(normalizedAgentName, []);
    return [];
  }
  const skillsDir = join(agentsDir, normalizedAgentName, 'skills');
  if (!(await isDirectory(skillsDir))) {
    cachedAgentSkills.set(normalizedAgentName, []);
    return [];
  }

  const skills = await listBuiltinSkillsInDir(
    skillsDir,
    BUILTIN_AGENT_SOURCE_KIND,
    normalizedAgentName,
  );
  cachedAgentSkills.set(normalizedAgentName, skills);
  return skills;
}

async function listBuiltinSkillsInDir(
  skillsDir: string,
  sourceKind: string,
  agentName?: string,
): Promise<LocalBuiltinSkillInfo[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const skills: LocalBuiltinSkillInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, SKILL_FILE);
    const content = await readFile(skillPath, 'utf8').catch(() => undefined);
    if (!content) continue;
    const frontmatter = parseSkillFrontmatter(content);
    if (frontmatter.listed === false) continue;
    const name = frontmatter.name || entry.name;
    if (!isLocalBuiltinSkillEnabled(name)) continue;
    skills.push({
      name,
      description: frontmatter.description || '',
      scope: BUILTIN_SCOPE,
      location: skillPath,
      source_type: BUILTIN_SOURCE_TYPE,
      source_kind: sourceKind,
      ...(frontmatter.requires_beta ? { requires_beta: frontmatter.requires_beta } : {}),
      ...(agentName ? { agent_name: agentName } : {}),
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function listSkillFilesFromDir(
  baseDir: string,
  relativeDir = '',
): Promise<LocalBuiltinSkillFileNode[]> {
  const absoluteDir = relativeDir ? join(baseDir, relativeDir) : baseDir;
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  const nodes = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map(async (entry) => {
        const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
        const node: LocalBuiltinSkillFileNode = {
          name: entry.name,
          path: relativePath,
          isDir: entry.isDirectory(),
        };
        if (entry.isDirectory()) node.children = await listSkillFilesFromDir(baseDir, relativePath);
        return node;
      }),
  );
  return nodes;
}

export function buildLocalSkillsSystemPrompt(
  basePrompt: string,
  skills: readonly LocalSkillPromptInfo[],
  registryCatalog?: string,
): string {
  // Clean local-runtime no longer carries its own output protocol. The agent
  // persona/session prompt provides behavior, and the skills block only lists
  // callable workflows just like preview_train.
  const skillBlock =
    registryCatalog?.trim() ||
    renderLocalSkillsCatalog(
      skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        builtin: typeof skill.source_kind === 'string' && skill.source_kind.startsWith('builtin-'),
      })),
    );
  return [basePrompt, skillBlock].filter((part) => part.trim().length > 0).join('\n\n');
}

export interface LocalBuiltinSkillListOptions {
  keyword?: string;
  sourceType?: number;
  excludeBuiltin?: boolean;
  limit?: number;
  nextToken?: string;
}

export interface LocalBuiltinSkillListResult {
  skills: LocalBuiltinSkillInfo[];
  has_more: boolean;
  next_token: string;
}

export async function listLocalBuiltinSkillsForApi(
  options: LocalBuiltinSkillListOptions = {},
): Promise<LocalBuiltinSkillListResult> {
  let skills = await listLocalBuiltinSkills();
  if (options.excludeBuiltin || options.sourceType === 2) {
    skills = [];
  } else if (options.sourceType === 1 || options.sourceType === 0 || options.sourceType == null) {
    skills = [...skills];
  } else {
    skills = [];
  }

  const keyword = options.keyword?.trim().toLowerCase();
  if (keyword) {
    skills = skills.filter((skill) =>
      `${skill.name}\n${skill.description}`.toLowerCase().includes(keyword),
    );
  }

  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.nextToken);
  const page = skills.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < skills.length;
  return {
    skills: page,
    has_more: hasMore,
    next_token: hasMore ? String(nextOffset) : '',
  };
}

export function filterLocalSkillsForInjection(
  skills: readonly LocalBuiltinSkillInfo[],
  betaFlags: Readonly<Record<string, boolean | undefined>>,
): LocalBuiltinSkillInfo[] {
  return skills.filter((skill) => {
    if (!skill.requires_beta) return true;
    return betaFlags[skill.requires_beta] === true;
  });
}

function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  listed?: boolean;
  requires_beta?: string;
} {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  const data = yaml.load(match[1] ?? '');
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return {};
  const obj = data as Record<string, unknown>;
  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    description: typeof obj.description === 'string' ? obj.description : undefined,
    listed: typeof obj.listed === 'boolean' ? obj.listed : undefined,
    requires_beta:
      typeof obj.requiresBeta === 'string' && obj.requiresBeta.trim() !== ''
        ? obj.requiresBeta.trim()
        : undefined,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function normalizeOffset(nextToken: string | undefined): number {
  if (!nextToken) return 0;
  const offset = Number(nextToken);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.trunc(offset);
}

export function readOptionalNumber(value: string | null): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function readOptionalBoolean(value: string | null): boolean | undefined {
  if (value == null) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

async function resolveBuiltinSkillsDir(): Promise<string | undefined> {
  for (const candidate of getBuiltinSkillsDirCandidates()) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

async function resolveBuiltinAgentsDir(): Promise<string | undefined> {
  for (const candidate of getBuiltinAgentsDirCandidates()) {
    if (await isDirectory(candidate)) return candidate;
  }
  return undefined;
}

export function getBuiltinSkillsDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return dedupePaths([
    process.env.MAVIS_BUILTIN_SKILLS_DIR,
    resolve(here, '../../assets/skills'),
    resolve(here, 'assets/skills'),
    resolve(process.cwd(), 'packages/local-runtime/assets/skills'),
    resolve(process.cwd(), 'node_modules/@mavis/local-runtime/assets/skills'),
  ]);
}

export function getBuiltinAgentsDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return dedupePaths([
    process.env.MAVIS_BUILTIN_AGENTS_DIR,
    resolve(here, '../../assets/agents'),
    resolve(here, 'assets/agents'),
    resolve(here, '../../../local-runtime-v2/assets/agents'),
    resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents'),
    resolve(process.cwd(), 'assets/agents'),
  ]);
}

function normalizeAgentName(agentName: string): string {
  return agentName === LEGACY_PRIMARY_AGENT_NAME ? PRIMARY_AGENT_NAME : agentName;
}

function dedupePaths(paths: Array<string | undefined>): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    await access(path);
    const entries = await readdir(path, { withFileTypes: true });
    return entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}
