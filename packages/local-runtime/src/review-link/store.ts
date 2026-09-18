/**
 * Persistence for recorded review links.
 *
 * Entries are keyed by `<workspaceDir>\n<branch>` rather than by session id.
 * A review belongs to a branch, not to the conversation that happened to open
 * it, so keying by branch is what makes the status line keep working after the
 * session is resumed, forked, or replaced by a fresh one on the same checkout.
 *
 * Everything here is derived state: losing the file costs the user a status
 * line entry until the next `gh`/`glab` invocation, never real work. That is
 * why a malformed file is discarded rather than repaired.
 */

import fs, { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import type { ReviewLinkOrigin, ReviewLinkVendor } from './parse.js';

export interface ReviewLinkEntry {
  vendor: ReviewLinkVendor;
  url: string;
  number: number;
  branch: string;
  origin: ReviewLinkOrigin;
  /** Unix ms (repo rule: never ISO strings in storage). */
  recordedAt: number;
}

export interface ReviewLinkData {
  version: 1;
  links: Record<string, ReviewLinkEntry>;
}

const REVIEW_LINK_FILE = 'review-links.json';

/**
 * Upper bound on retained entries. One entry per branch per workspace stays
 * small in normal use; the cap only matters for long-lived installs that
 * accumulate abandoned branches. Eviction drops the oldest recordings first.
 */
const MAX_ENTRIES = 500;

const VENDORS: ReadonlySet<string> = new Set<ReviewLinkVendor>(['github', 'gitlab']);
const ORIGINS: ReadonlySet<string> = new Set<ReviewLinkOrigin>(['created', 'viewed']);

const mutationTails = new Map<string, Promise<void>>();

/**
 * Builds the lookup key for one workspace/branch pair.
 *
 * A newline separator cannot collide: it is legal in neither a POSIX path
 * component boundary we produce nor a git branch name (git rejects control
 * characters in refs).
 */
export function reviewLinkKey(workspaceDir: string, branch: string): string {
  return `${workspaceDir}\n${branch}`;
}

export function emptyReviewLinkData(): ReviewLinkData {
  return { version: 1, links: {} };
}

export function loadReviewLinkData(dataDir: string): ReviewLinkData {
  return loadReviewLinkFile(resolve(dataDir, REVIEW_LINK_FILE));
}

function loadReviewLinkFile(filePath: string): ReviewLinkData {
  if (!existsSync(filePath)) return emptyReviewLinkData();
  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyReviewLinkData();
    const links = (raw as { links?: unknown }).links;
    if (!links || typeof links !== 'object' || Array.isArray(links)) return emptyReviewLinkData();
    const parsed: Record<string, ReviewLinkEntry> = {};
    for (const [key, value] of Object.entries(links as Record<string, unknown>)) {
      const entry = sanitizeEntry(value);
      if (entry) parsed[key] = entry;
    }
    return { version: 1, links: parsed };
  } catch {
    // Corrupt or truncated cache — rebuildable, so start clean rather than
    // failing the caller.
    return emptyReviewLinkData();
  }
}

/**
 * Validates one persisted entry, returning `undefined` when any field is
 * missing or the wrong shape. Partial entries are dropped whole: a status line
 * item rendered from half-known data would be worse than no item.
 */
function sanitizeEntry(value: unknown): ReviewLinkEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { vendor, url, branch, origin } = record;
  const number = record.number;
  const recordedAt = record.recordedAt;
  if (typeof vendor !== 'string' || !VENDORS.has(vendor)) return undefined;
  if (typeof origin !== 'string' || !ORIGINS.has(origin)) return undefined;
  if (typeof url !== 'string' || !url) return undefined;
  if (typeof branch !== 'string' || !branch) return undefined;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return undefined;
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return undefined;
  return {
    vendor: vendor as ReviewLinkVendor,
    origin: origin as ReviewLinkOrigin,
    url,
    branch,
    number,
    recordedAt,
  };
}

export class LocalReviewLinkStore {
  constructor(private readonly getDataDir: () => string) {}

  /**
   * Reads the review link recorded for one workspace/branch pair.
   *
   * Reads are synchronous and uncached because the only caller is the TUI
   * status line, which already refreshes on a timer and re-reads a small file.
   */
  read(workspaceDir: string, branch: string): ReviewLinkEntry | undefined {
    if (!workspaceDir || !branch) return undefined;
    const data = loadReviewLinkData(this.getDataDir());
    return data.links[reviewLinkKey(workspaceDir, branch)];
  }

  /**
   * Records a review link for one workspace/branch pair.
   *
   * A later recording replaces an earlier one for the same branch, except that
   * a `viewed` observation never overwrites a `created` one: the review this
   * session opened is the more specific fact, and `gh pr view` run afterwards
   * on the same branch should not downgrade it.
   */
  async record(workspaceDir: string, entry: ReviewLinkEntry): Promise<ReviewLinkEntry | undefined> {
    if (!workspaceDir || !entry.branch) return undefined;
    const key = reviewLinkKey(workspaceDir, entry.branch);
    return this.mutate((data) => {
      const previous = data.links[key];
      if (previous && previous.origin === 'created' && entry.origin === 'viewed') {
        return previous;
      }
      data.links[key] = entry;
      evictOverflow(data);
      return entry;
    });
  }

  private async mutate<T>(mutate: (data: ReviewLinkData) => T): Promise<T> {
    const filePath = resolve(this.getDataDir(), REVIEW_LINK_FILE);
    const previous = mutationTails.get(filePath) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const data = loadReviewLinkFile(filePath);
        const result = mutate(data);
        await this.write(filePath, data);
        return result;
      });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    mutationTails.set(filePath, tail);
    try {
      return await operation;
    } finally {
      if (mutationTails.get(filePath) === tail) mutationTails.delete(filePath);
    }
  }

  private async write(filePath: string, data: ReviewLinkData): Promise<void> {
    await fs.promises.mkdir(dirname(filePath), { recursive: true });
    const tmpPath = join(dirname(filePath), `.review-links-tmp-${randomBytes(6).toString('hex')}`);
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

function evictOverflow(data: ReviewLinkData): void {
  const keys = Object.keys(data.links);
  if (keys.length <= MAX_ENTRIES) return;
  const oldestFirst = keys.sort(
    (left, right) => (data.links[left]?.recordedAt ?? 0) - (data.links[right]?.recordedAt ?? 0),
  );
  for (const key of oldestFirst.slice(0, keys.length - MAX_ENTRIES)) {
    delete data.links[key];
  }
}

export function __resetReviewLinkMutationTailsForTests(): void {
  mutationTails.clear();
}
