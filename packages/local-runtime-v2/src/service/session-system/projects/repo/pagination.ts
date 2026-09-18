import type { ProjectPage, ProjectRecord } from './contract.js';

export type ProjectPageKind = 'catalog-visible' | 'catalog-all' | 'recent';

export interface RecentProjectCursor {
  readonly kind: 'recent';
  readonly projectId: number;
  readonly recentAtMs: number;
}

export interface CatalogProjectCursor {
  readonly kind: Exclude<ProjectPageKind, 'recent'>;
  readonly projectId: number;
  readonly pinned: boolean;
  readonly orderIndex: number;
  readonly latestActivityAtMs: number;
}

export type ProjectCursor = RecentProjectCursor | CatalogProjectCursor;

export function projectPageFromRows(
  records: readonly ProjectRecord[],
  limit: number,
  kind: ProjectPageKind,
): ProjectPage {
  const projects = records.slice(0, limit);
  const hasMore = records.length > limit;
  const last = projects.at(-1);
  return {
    projects,
    hasMore,
    ...(hasMore && last ? { nextCursor: encodeProjectCursor(last, kind) } : {}),
  };
}

export function normalizeProjectLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  const normalized = Math.floor(value);
  return normalized > 0 ? Math.min(normalized, 200) : 50;
}

function encodeProjectCursor(record: ProjectRecord, kind: ProjectPageKind): string {
  const value =
    kind === 'recent'
      ? { v: 1, k: kind, i: record.projectId, r: record.recentAtMs }
      : {
          v: 1,
          k: kind,
          i: record.projectId,
          p: record.pinned,
          o: record.orderIndex,
          a: record.latestActivityAtMs,
        };
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeProjectCursor(
  value: string | undefined,
  kind: ProjectPageKind,
): ProjectCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!isCursorEnvelope(parsed, kind)) return undefined;
    return kind === 'recent' ? decodeRecentCursor(parsed) : decodeCatalogCursor(parsed, kind);
  } catch {
    return undefined;
  }
}

function isCursorEnvelope(
  value: unknown,
  kind: ProjectPageKind,
): value is Record<string, unknown> & { readonly i: number } {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.k === kind &&
    Number.isSafeInteger(value.i) &&
    (value.i as number) > 0
  );
}

function decodeRecentCursor(
  value: Record<string, unknown> & { readonly i: number },
): RecentProjectCursor | undefined {
  return Number.isFinite(value.r)
    ? { kind: 'recent', projectId: value.i, recentAtMs: value.r as number }
    : undefined;
}

function decodeCatalogCursor(
  value: Record<string, unknown> & { readonly i: number },
  kind: Exclude<ProjectPageKind, 'recent'>,
): CatalogProjectCursor | undefined {
  if (typeof value.p !== 'boolean' || !Number.isSafeInteger(value.o) || !Number.isFinite(value.a)) {
    return undefined;
  }
  return {
    kind,
    projectId: value.i,
    pinned: value.p,
    orderIndex: value.o as number,
    latestActivityAtMs: value.a as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
