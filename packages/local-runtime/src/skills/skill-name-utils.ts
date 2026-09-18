// Skill identity/name derivation helpers, extracted from hub-api.ts to keep that
// file under the local-runtime layout budget. Pure functions, no I/O.

function slugifySkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
}

export function normalizeSkillName(value: string): string {
  return slugifySkillName(value) || 'local-skill';
}

export function deriveSkillName(sourceUrl: string): string {
  const last = sourceUrl.split(/[/?#]/u).filter(Boolean).pop() ?? 'skill';
  return normalizeSkillName(last.replace(/\.git$/u, ''));
}

/** Short, deterministic FNV-1a slug used to disambiguate non-ASCII identities. */
function skillIdentityHash(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Read the SKILL.md frontmatter `name:` — the skill's canonical identity. */
function readFrontmatterSkillName(content: string | undefined): string | undefined {
  if (!content) return undefined;
  const block = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(content);
  const frontmatter = block?.[1];
  if (!frontmatter) return undefined;
  const line = /^name:[ \t]*(.+?)[ \t]*$/mu.exec(frontmatter);
  const value = line?.[1];
  if (!value) return undefined;
  return value.replace(/^["']|["']$/gu, '').trim() || undefined;
}

/**
 * Resolve a stable, collision-free identity for an installed hub skill. This
 * name is used as the on-disk directory, the hub dedup key, and the `installed`
 * detection key, so distinct skills MUST map to distinct names. Collapsing many
 * skills onto a shared fallback (previously `local-skill`, produced whenever the
 * display name normalized to empty — e.g. a purely CJK title) let one skill's
 * install/delete clobber another (Meego 7034460887 / 7034606585 / 7034556857).
 *
 * Priority: caller-provided name → the matched hub item's own name → the
 * skill's frontmatter name (what the registry and remote hub key by, so market
 * "added" detection matches) → the source-URL slug → a hash of the source URL
 * and display name.
 */
export function resolveInstallSkillName(input: {
  explicitName?: string;
  existingName?: string;
  content?: string;
  displayName: string;
  sourceUrl: string;
}): string {
  const explicit = input.explicitName ? slugifySkillName(input.explicitName) : '';
  if (explicit) return explicit;
  const existing = input.existingName ? slugifySkillName(input.existingName) : '';
  if (existing) return existing;
  const frontmatterName = readFrontmatterSkillName(input.content);
  const fromFrontmatter = frontmatterName ? slugifySkillName(frontmatterName) : '';
  if (fromFrontmatter) return fromFrontmatter;
  const lastSegment = input.sourceUrl.split(/[/?#]/u).filter(Boolean).pop() ?? '';
  const fromUrl = slugifySkillName(lastSegment.replace(/\.git$/u, ''));
  if (fromUrl) return fromUrl;
  return `skill-${skillIdentityHash(`${input.sourceUrl} ${input.displayName}`)}`;
}
