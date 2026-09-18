import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import yaml from 'yaml';
import { CONTROL_IN_APP_BROWSER_SKILL_NAME } from '@mavis/agent-tools/desktop';

import type { BrowserUseBuiltinSkillDescriptor } from './contracts.js';

let cached: BrowserUseBuiltinSkillDescriptor | undefined;

/** Reads the package-owned Browser Skill and fails closed when packaging is incomplete. */
export function readBrowserUseBuiltinSkillAsset(): BrowserUseBuiltinSkillDescriptor {
  cached ??= loadBrowserUseBuiltinSkillAsset();
  return cached;
}

function loadBrowserUseBuiltinSkillAsset(): BrowserUseBuiltinSkillDescriptor {
  const location = resolveBrowserUseSkillAssetPath();
  const content = readFileSync(location, 'utf8');
  const frontmatter = parseFrontmatter(content);
  if (frontmatter.name !== CONTROL_IN_APP_BROWSER_SKILL_NAME) {
    throw new Error('Browser Use built-in Skill has an invalid name.');
  }
  const description =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) throw new Error('Browser Use built-in Skill has no description.');
  return Object.freeze({
    name: CONTROL_IN_APP_BROWSER_SKILL_NAME,
    description,
    content,
    location: pathToFileURL(location).href.replace(/^file:/u, 'files:'),
    sourceKind: 'builtin',
  });
}

function resolveBrowserUseSkillAssetPath(): string {
  const relative = join('mavis', 'skills', CONTROL_IN_APP_BROWSER_SKILL_NAME, 'SKILL.md');
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../assets/agents', relative),
    resolve(here, 'assets/agents', relative),
    resolve(process.cwd(), 'packages/local-runtime-v2/assets/agents', relative),
    resolve(process.cwd(), 'assets/agents', relative),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // Continue through source, compiled package, and bundled package layouts.
    }
  }
  throw new Error('Browser Use built-in Skill asset is missing.');
}

function parseFrontmatter(content: string): Readonly<Record<string, unknown>> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) throw new Error('Browser Use built-in Skill has no frontmatter.');
  const value: unknown = yaml.parse(match[1] ?? '');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser Use built-in Skill frontmatter is invalid.');
  }
  return value as Readonly<Record<string, unknown>>;
}
