import type { LocalSkillArchiveScan, LocalSkillPreviewRepoInfo } from './archive.js';
import { resolveRemoteArchiveCandidates } from './github.js';

type CacheEntry = { expiresAtMs: number; promise: Promise<LocalSkillArchiveScan> };

const REMOTE_SKILL_PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const REMOTE_SKILL_PREVIEW_CACHE_MAX = 8;

export class RemoteSkillPreviewCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly nowMs: () => number) {}

  read(keys: string[]): Promise<LocalSkillArchiveScan> | undefined {
    const now = this.nowMs();
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
        continue;
      }
      return entry.promise;
    }
    return undefined;
  }

  write(keys: string[], promise: Promise<LocalSkillArchiveScan>): CacheEntry {
    const entry = { expiresAtMs: this.nowMs() + REMOTE_SKILL_PREVIEW_CACHE_TTL_MS, promise };
    for (const key of keys) this.entries.set(key, entry);
    this.trim();
    return entry;
  }

  deleteEntry(entry: CacheEntry): void {
    for (const [key, cached] of this.entries) {
      if (cached === entry) this.entries.delete(key);
    }
  }

  private trim(): void {
    const uniqueEntries = new Set(this.entries.values());
    if (uniqueEntries.size <= REMOTE_SKILL_PREVIEW_CACHE_MAX) return;
    const oldestEntries = [...uniqueEntries].sort((a, b) => a.expiresAtMs - b.expiresAtMs);
    for (const entry of oldestEntries.slice(
      0,
      uniqueEntries.size - REMOTE_SKILL_PREVIEW_CACHE_MAX,
    )) {
      this.deleteEntry(entry);
    }
  }
}

export function remoteSkillArchiveCacheKeys(
  sourceUrl: string,
  repoInfo?: LocalSkillPreviewRepoInfo,
  ref?: string,
): string[] {
  const keys = new Set<string>();
  keys.add(remoteSkillUrlCacheKey(sourceUrl, ref));
  for (const archive of resolveRemoteArchiveCandidates(sourceUrl, ref)) {
    addRepoInfoCacheKeys(keys, archive.repoInfo);
  }
  if (repoInfo) addRepoInfoCacheKeys(keys, repoInfo);
  return [...keys];
}

export function remoteSkillUrlCacheKey(sourceUrl: string, ref?: string): string {
  return `url:${sourceUrl}|ref:${ref ?? ''}`;
}

export function remoteSkillInstallHint(sourceUrl: string, ref?: string): string | undefined {
  return resolveRemoteArchiveCandidates(sourceUrl, ref)[0]?.scanHintSubPath;
}

function addRepoInfoCacheKeys(keys: Set<string>, repoInfo: LocalSkillPreviewRepoInfo): void {
  const repoUrl = normalizeRepoUrl(repoInfo.repo_url ?? repoInfo.source_url);
  if (!repoUrl) return;
  if (repoInfo.sha) keys.add(`repo:${repoUrl}|sha:${repoInfo.sha}`);
  if (repoInfo.branch) keys.add(`repo:${repoUrl}|branch:${repoInfo.branch}`);
}

function normalizeRepoUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'github.com' || hostname === 'www.github.com') {
      const [owner, repo] = url.pathname.split('/').filter(Boolean);
      if (owner && repo) return `https://github.com/${owner}/${repo.replace(/\.git$/iu, '')}`;
    }
  } catch {
    // Fall through to conservative string normalization.
  }
  return value.replace(/\/+$/u, '').replace(/\.git$/iu, '');
}
