import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import { sessions } from '../../../../../infra/db/schema/sessions.js';
import { normalizeAbsolutePath } from '../../../shared/path-normalization.js';
import { sessionAgentNamePredicate } from '../agent-name-predicate.js';
import type { SessionCountOptions, SessionListOptions } from '../contract.js';

export function sessionListPredicate(
  options: SessionListOptions | SessionCountOptions,
): SQL | undefined {
  return and(
    eq(sessions.columnarVersion, 3),
    listAgentPredicate(options),
    listRuntimePredicate(options),
    workspacePredicate(options.workspaceDir),
    requiredWorkspacePredicate(options.requireWorkspaceDir),
    listOriginPredicate(options),
    listParentPredicate(options),
    archivedPredicate(options.archived),
    listTypePredicate(options),
    listVisibilityPredicate(options),
    includedKindsPredicate(options.includeSessionKinds),
    excludedKindsPredicate(options.excludeSessionKinds),
    startsWithPredicate(options.includePurposePrefix),
    notStartsWithPredicate(options.excludePurposePrefix),
    listSearchPredicate(options),
  );
}

function listAgentPredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
  return sessionAgentNamePredicate(options.agentName);
}

function listRuntimePredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
  return 'runtime' in options && options.runtime
    ? eq(sessions.runtime, options.runtime)
    : undefined;
}

function workspacePredicate(workspaceDir: string | undefined): SQL | undefined {
  if (workspaceDir === undefined) return undefined;
  const normalized = normalizeAbsolutePath(workspaceDir);
  if (!normalized) return sql`0`;
  return /^[A-Za-z]:[\\/]|^\\\\/u.test(normalized)
    ? eq(sql<string>`lower(${sessions.workspaceDir})`, normalized.toLocaleLowerCase())
    : eq(sessions.workspaceDir, normalized);
}

function requiredWorkspacePredicate(required: boolean | undefined): SQL | undefined {
  return required ? isNotNull(sessions.workspaceDir) : undefined;
}

function listParentPredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
  if (!('parentSessionId' in options) || options.parentSessionId === undefined) return undefined;
  return options.parentSessionId === null
    ? isNull(sessions.parentSessionId)
    : eq(sessions.parentSessionId, options.parentSessionId);
}

function listOriginPredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
  return 'originCronId' in options && options.originCronId
    ? eq(sessions.originCronId, options.originCronId)
    : undefined;
}

function archivedPredicate(archived: boolean | undefined): SQL | undefined {
  return archived === undefined ? undefined : eq(sessions.archived, archived ? 1 : 0);
}

function listTypePredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
  return options.sessionType ? eq(sessions.sessionType, options.sessionType) : undefined;
}

function listVisibilityPredicate(
  options: SessionListOptions | SessionCountOptions,
): SQL | undefined {
  return options.includeHidden === false ? ne(sessions.visibility, 'hidden') : undefined;
}

function includedKindsPredicate(kinds: SessionListOptions['includeSessionKinds']): SQL | undefined {
  return kinds?.length ? inArray(sessions.sessionKind, [...kinds]) : undefined;
}

function excludedKindsPredicate(kinds: SessionListOptions['excludeSessionKinds']): SQL | undefined {
  return kinds?.length ? notInArray(sessions.sessionKind, [...kinds]) : undefined;
}

function listSearchPredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
  const search = 'search' in options ? options.search?.trim().toLocaleLowerCase() : undefined;
  return search ? sessionSubstringPredicate(search) : undefined;
}

function startsWithPredicate(prefix: string | undefined): SQL | undefined {
  return prefix ? sql`substr(${sessions.purpose}, 1, ${prefix.length}) = ${prefix}` : undefined;
}

function notStartsWithPredicate(prefix: string | undefined): SQL | undefined {
  return prefix
    ? or(
        isNull(sessions.purpose),
        sql`substr(${sessions.purpose}, 1, ${prefix.length}) <> ${prefix}`,
      )
    : undefined;
}

function sessionSubstringPredicate(search: string): SQL {
  const value = `%${search}%`;
  return sql`(
    lower(${sessions.sessionId}) LIKE ${value}
    OR lower(coalesce(${sessions.agentName}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.title}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.workspaceDir}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.purpose}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.status}, '')) LIKE ${value}
    OR lower(coalesce(${sessions.sessionType}, '')) LIKE ${value}
  )`;
}
