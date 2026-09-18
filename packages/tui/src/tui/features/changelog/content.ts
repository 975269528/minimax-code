import { readFileSync } from 'node:fs';
import { getRuntimeLocaleLanguage } from '@mavis/shared/runtime-i18n';

declare const __IS_NPM_BUILD__: boolean | undefined;

export type TuiChangelogLanguage = 'en' | 'zh-CN';

const TUI_CHANGELOG_PATHS: Readonly<Record<TuiChangelogLanguage, string>> =
  typeof __IS_NPM_BUILD__ !== 'undefined' && __IS_NPM_BUILD__
    ? {
        en: './CHANGELOG.md',
        'zh-CN': './CHANGELOG.zh-CN.md',
      }
    : {
        en: '../../../../CHANGELOG.md',
        'zh-CN': '../../../../CHANGELOG.zh-CN.md',
      };

export const TUI_CHANGELOG_URLS: Readonly<Record<TuiChangelogLanguage, URL>> = {
  en: new URL(TUI_CHANGELOG_PATHS.en, import.meta.url),
  'zh-CN': new URL(TUI_CHANGELOG_PATHS['zh-CN'], import.meta.url),
};

export function resolveTuiChangelogLanguage(
  locale: string = resolveSystemLocale(),
): TuiChangelogLanguage {
  return getRuntimeLocaleLanguage(locale) === 'zh' ? 'zh-CN' : 'en';
}

export function readPackagedTuiChangelog(locale?: string): string | undefined {
  const language = resolveTuiChangelogLanguage(locale);
  const candidates =
    language === 'zh-CN'
      ? [TUI_CHANGELOG_URLS['zh-CN'], TUI_CHANGELOG_URLS.en]
      : [TUI_CHANGELOG_URLS.en];
  for (const url of candidates) {
    try {
      return readFileSync(url, 'utf8');
    } catch {
      // Localized release notes are optional; English is the deterministic fallback.
    }
  }
  return undefined;
}

export function extractTuiChangelogMarkdown(source: string): string {
  const normalized = source.replace(/\r\n?/gu, '\n').trim();
  const firstRelease = normalized.search(/^##\s+/mu);
  return firstRelease >= 0 ? normalized.slice(firstRelease) : normalized;
}

export function extractTuiVersionChangelogEntries(
  source: string,
  version: string,
): readonly string[] {
  const normalized = source.replace(/\r\n?/gu, '\n');
  const escapedVersion = escapeRegExp(version.trim());
  if (!escapedVersion) return [];

  const heading = new RegExp(`^##\\s+\\[?v?${escapedVersion}\\]?(?=\\s|·|-|$).*$`, 'imu').exec(
    normalized,
  );
  if (!heading) return [];

  const afterHeading = normalized.slice((heading.index ?? 0) + heading[0].length);
  const nextHeading = afterHeading.search(/^##\s+/mu);
  const section = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  return parseMarkdownBulletEntries(section);
}

export function selectRandomTuiItems<T>(
  items: readonly T[],
  count: number,
  random: () => number = Math.random,
): readonly T[] {
  const pool = [...items];
  const selected: T[] = [];
  const limit = Math.min(pool.length, Math.max(0, Math.trunc(count)));
  for (let index = 0; index < limit; index += 1) {
    const raw = random();
    const normalized = Number.isFinite(raw) ? Math.max(0, Math.min(raw, 0.9999999999999999)) : 0;
    const selectedIndex = Math.floor(normalized * pool.length);
    selected.push(pool.splice(selectedIndex, 1)[0] as T);
  }
  return selected;
}

function parseMarkdownBulletEntries(section: string): readonly string[] {
  const entries: string[] = [];
  let current = '';
  const flush = (): void => {
    const normalized = normalizeMarkdownInline(current);
    if (normalized) entries.push(normalized);
    current = '';
  };

  for (const line of section.split('\n')) {
    const bullet = /^\s*-\s+(.+)$/u.exec(line);
    if (bullet) {
      flush();
      current = bullet[1] ?? '';
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s+/u.test(trimmed)) {
      flush();
      continue;
    }
    if (current) current += ` ${trimmed}`;
  }
  flush();
  return entries;
}

function normalizeMarkdownInline(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en';
  }
}
