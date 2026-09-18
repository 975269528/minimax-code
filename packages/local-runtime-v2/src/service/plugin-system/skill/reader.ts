import path from 'node:path';

import { readPluginTextFile, type CanonicalPluginRoot } from '../plugin/package/filesystem.js';
import { readerFail } from '../plugin/package/reader-errors.js';
import type { PluginSkill } from '../plugin/package/types.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import { fallbackSkillName, readSkillStringField } from './identity.js';

export async function readPluginSkill(
  root: CanonicalPluginRoot,
  relativeSkillFile: string,
  options: { expectedName?: string; portable?: boolean; agentSkills?: boolean } = {},
): Promise<PluginSkill> {
  const { path: skillFilePath, content } = await readPluginTextFile(root, relativeSkillFile, {
    portable: options.portable,
    rejectBom: true,
  });
  const frontmatter = parseSkillFrontmatter(content, relativeSkillFile);
  if (options.agentSkills) validateAgentSkillsFrontmatter(frontmatter, relativeSkillFile);
  const declaredName = readSkillStringField(frontmatter, 'name');
  const name =
    declaredName ?? (options.agentSkills ? undefined : fallbackSkillName(relativeSkillFile));
  const description = readSkillStringField(frontmatter, 'description');
  if (!name) readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} has no Skill name`);
  if (!description) {
    readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} has no Skill description`);
  }
  if (options.expectedName !== undefined && name !== options.expectedName) {
    readerFail(
      'SKILL_SCHEMA_INVALID',
      `${relativeSkillFile} frontmatter name does not match its directory`,
    );
  }
  return {
    name,
    description,
    content,
    skillFilePath,
    skillRoot: path.dirname(skillFilePath),
  };
}

function validateAgentSkillsFrontmatter(
  frontmatter: Record<string, unknown>,
  relativeSkillFile: string,
): void {
  requireOptionalString(frontmatter, 'license', relativeSkillFile);
  requireOptionalString(frontmatter, 'allowed-tools', relativeSkillFile);
  const compatibility = requireOptionalString(frontmatter, 'compatibility', relativeSkillFile);
  if (compatibility !== undefined && (compatibility.length === 0 || compatibility.length > 500)) {
    readerFail(
      'SKILL_SCHEMA_INVALID',
      `${relativeSkillFile} compatibility must contain 1-500 characters`,
    );
  }
  const metadata = frontmatter.metadata;
  if (
    metadata !== undefined &&
    (!isRecord(metadata) || Object.values(metadata).some((value) => typeof value !== 'string'))
  ) {
    readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} metadata must map strings to strings`);
  }
}

function requireOptionalString(
  frontmatter: Record<string, unknown>,
  key: string,
  relativeSkillFile: string,
): string | undefined {
  const value = frontmatter[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} ${key} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
