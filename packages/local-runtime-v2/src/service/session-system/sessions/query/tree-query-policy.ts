import type { SessionKind, SessionTreeFilter } from '../repo/contract.js';
import { sessionKindForLegacyPurposePrefix } from '../repo/drizzle/normalization.js';

export interface SessionTreeFilterRequest {
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly onlyCompressed?: boolean;
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
}

export function sessionTreeFilterFromRequest(
  request: SessionTreeFilterRequest,
  includeHidden: boolean,
): SessionTreeFilter {
  const includeKind = mapPurposePrefix(request.includePurposePrefix);
  const excludeKind = mapPurposePrefix(request.excludePurposePrefix);
  const excluded = excludedKinds(request, includeHidden, excludeKind);
  return {
    archived: archiveFilter(request),
    includeHidden,
    excludeInternalTreeSessions: !includeHidden,
    ...optionalKind('includeSessionKinds', includeKind),
    ...optionalKinds('excludeSessionKinds', excluded),
    ...literalPurposeFilters(request, includeKind, excludeKind),
  };
}

function mapPurposePrefix(prefix: string | undefined): SessionKind | undefined {
  return prefix ? sessionKindForLegacyPurposePrefix(prefix) : undefined;
}

function archiveFilter(request: SessionTreeFilterRequest): boolean | undefined {
  if (request.onlyArchived === true || request.onlyCompressed === true) return true;
  return request.includeArchived === true ? undefined : false;
}

function excludedKinds(
  request: SessionTreeFilterRequest,
  includeHidden: boolean,
  excludeKind: SessionKind | undefined,
): readonly SessionKind[] {
  const defaults: readonly SessionKind[] =
    includeHidden || request.includePurposePrefix ? [] : ['cron'];
  return excludeKind ? [...new Set([...defaults, excludeKind])] : defaults;
}

function optionalKind(
  _key: 'includeSessionKinds',
  kind: SessionKind | undefined,
): Pick<SessionTreeFilter, 'includeSessionKinds'> {
  return kind ? { includeSessionKinds: [kind] } : {};
}

function optionalKinds(
  _key: 'excludeSessionKinds',
  kinds: readonly SessionKind[],
): Pick<SessionTreeFilter, 'excludeSessionKinds'> {
  return kinds.length > 0 ? { excludeSessionKinds: kinds } : {};
}

function literalPurposeFilters(
  request: SessionTreeFilterRequest,
  includeKind: SessionKind | undefined,
  excludeKind: SessionKind | undefined,
): Pick<SessionTreeFilter, 'includePurposePrefix' | 'excludePurposePrefix'> {
  return {
    ...(request.includePurposePrefix && !includeKind
      ? { includePurposePrefix: request.includePurposePrefix }
      : {}),
    ...(request.excludePurposePrefix && !excludeKind
      ? { excludePurposePrefix: request.excludePurposePrefix }
      : {}),
  };
}
