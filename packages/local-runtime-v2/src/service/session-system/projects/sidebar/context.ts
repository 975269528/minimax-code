import { createHash } from 'node:crypto';
import { SidebarQueryError, type SidebarQuery } from './contracts.js';

function stringSet(values: readonly string[] | undefined): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !v.trim())) {
    throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Expected nonempty strings');
  }
  return [...new Set(values.map((v) => v.trim()))].sort();
}
function enumSet(values: string[] | undefined, allowed: string[]): string[] {
  const result = stringSet(values);
  if (result.some((v) => !allowed.includes(v)))
    throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Unknown filter value');
  return result;
}
function projectIdSet(values: number[] = []): number[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Invalid project IDs');
  }
  return [...new Set(values)].sort((a, b) => a - b);
}
function activityDays(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (![1, 3, 7].includes(value))
    throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Invalid activity window');
  return value;
}
function normalizeInputs(input: SidebarQuery) {
  const filter = input.filter ?? {};
  const scope = input.scope ?? {};
  const statuses = enumSet(filter.statuses, ['unread', 'working', 'done']);
  return {
    ...(input.allProjects ? { allProjects: true } : {}),
    types: enumSet(filter.types, ['chat', 'task', 'cron', 'im']),
    statuses,
    agentNames: [
      ...new Set(stringSet(filter.agentNames).map((value) => (value === 'main' ? 'mavis' : value))),
    ].sort(),
    activityDays: activityDays(filter.activityDays),
    unreadIds: statuses.includes('unread') ? stringSet(scope.unreadSessionIds) : [],
    excludedIds: stringSet(scope.excludedSessionIds),
    excludedProjectIds: projectIdSet(scope.excludedProjectIds),
    bindingIds: stringSet(input.bindingIds),
    cronTargetIds: stringSet(input.cronTargetIds),
  };
}
function queryTime(input: SidebarQuery, hash: string, nowMs: number): number {
  if (!input.context) {
    if (input.cursor)
      throw new SidebarQueryError('SIDEBAR_QUERY_CONTEXT_MISMATCH', 'Cursor requires context');
    return nowMs;
  }
  const previous = decodeObject(input.context, 'SIDEBAR_QUERY_CONTEXT_MISMATCH');
  if (
    previous.v !== 1 ||
    previous.hash !== hash ||
    !Number.isSafeInteger(previous.nowMs) ||
    Number(previous.nowMs) < 0 ||
    Number(previous.nowMs) > nowMs
  ) {
    throw new SidebarQueryError('SIDEBAR_QUERY_CONTEXT_MISMATCH', 'Query context changed');
  }
  return Number(previous.nowMs);
}
export function normalizeSidebarQuery(input: SidebarQuery, nowMs: number, internalRootIds: readonly string[] = [], rootAgentNames?: readonly string[]) {
  const normalized = { ...normalizeInputs(input), internalRootIds: [...internalRootIds].sort(), ...(rootAgentNames ? { rootAgentNames: [...new Set(rootAgentNames)].sort() } : {}) };
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const queryNowMs = queryTime(input, hash, nowMs);
  const context = encodeObject({ v: 1, hash, nowMs: queryNowMs });
  return { ...normalized, hash, context, nowMs: queryNowMs };
}
export type NormalizedSidebarQuery = ReturnType<typeof normalizeSidebarQuery>;
export function encodeObject(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function decodeObject(
  value: string,
  key = 'SIDEBAR_INVALID_CURSOR',
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    /* mapped below */
  }
  throw new SidebarQueryError(key, 'Invalid query cursor');
}
const tupleValidators: Record<string, (last: unknown[]) => boolean> = {
  agents: (last) => last.length === 1 && typeof last[0] === 'string',
  projects: (last) =>
    last.length === 4 &&
    last.every(Number.isSafeInteger) &&
    [0, 1].includes(Number(last[0])) &&
    Number(last[3]) > 0,
  sessions: (last) =>
    last.length === 3 &&
    Number.isSafeInteger(last[0]) &&
    Number.isSafeInteger(last[1]) &&
    typeof last[2] === 'string',
};
export function readCursor(
  value: string | undefined,
  query: NormalizedSidebarQuery,
  kind: string,
  projectId?: number,
): unknown[] | undefined {
  if (!value) return undefined;
  const cursor = decodeObject(value);
  if (
    cursor.v !== 1 ||
    cursor.context !== query.context ||
    cursor.kind !== kind ||
    cursor.projectId !== projectId ||
    !Array.isArray(cursor.last)
  ) {
    throw new SidebarQueryError('SIDEBAR_INVALID_CURSOR', 'Cursor does not match this query');
  }
  const last = cursor.last;
  const valid = tupleValidators[kind]?.(last) ?? false;
  if (!valid) throw new SidebarQueryError('SIDEBAR_INVALID_CURSOR', 'Invalid sort tuple');
  return last;
}
export function pageLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200)
    throw new SidebarQueryError('SIDEBAR_INVALID_FILTER', 'Limit must be 1..200');
  return value;
}
