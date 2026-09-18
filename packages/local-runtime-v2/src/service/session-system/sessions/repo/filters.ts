import { and, eq, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER } from '@mavis/conversation-contract';

import { sessions } from '../../../../infra/db/schema/sessions.js';
import type { SessionTreeFilter } from './contract.js';

/**
 * Session kinds that form their own internal tree and are never part of the
 * user-facing conversation tree. They can carry `sessionType: 'root'` of their
 * own, so any root-scoped scan or mutation must exclude them explicitly.
 */
export const INTERNAL_TREE_SESSION_KINDS = ['peek', 'cron'] as const;

export function sessionTreePredicate(options: SessionTreeFilter): SQL | undefined {
  return and(
    options.archived === undefined ? undefined : eq(sessions.archived, options.archived ? 1 : 0),
    options.includeHidden ? undefined : ne(sessions.visibility, 'hidden'),
    options.excludeInternalTreeSessions
      ? notInArray(sessions.sessionKind, [...INTERNAL_TREE_SESSION_KINDS])
      : undefined,
    options.includeSessionKinds?.length
      ? inArray(sessions.sessionKind, [...options.includeSessionKinds])
      : undefined,
    options.excludeSessionKinds?.length
      ? notInArray(sessions.sessionKind, [...options.excludeSessionKinds])
      : undefined,
    startsWithPredicate(options.includePurposePrefix),
    notStartsWithPredicate(options.excludePurposePrefix),
  );
}

/** Sidebar eligibility for ordinary Main conversations and trusted legacy IM roots. */
export function projectConversationRootPredicate(): SQL {
  return and(
    eq(sessions.sessionType, 'root'),
    eq(sessions.sessionKind, 'conversation'),
    or(trustedLegacyImRootPurposePredicate(), notStartsWithPredicate('cron:')),
  )!;
}

/**
 * Project catalogs contain every parentless conversation-tree root: branch
 * roots and ordinary Agent roots alike.
 *
 * Why ordinary roots are admitted: the `session_count` trigger
 * (`migration-0006-session-storage-ddl.ts`) that maintains
 * `local_runtime_projects.session_count` never looked at `session_type`, so
 * excluding roots here made root-only Projects invisible to `listProjects`
 * (`gt(sessionCount, 0)` saw 0) while the persisted aggregate said 1 — the
 * client could then never read back the Project's `hidden` state. This
 * predicate is the query-side twin of that trigger and must stay aligned
 * with it, and with the UI mirror `isProjectSessionCountedRootTask`
 * (`packages/ui/.../archon-sidebar/utils.ts`).
 */
export function projectTaskRootPredicate(options: SessionTreeFilter): SQL | undefined {
  return and(
    isNull(sessions.parentSessionId),
    or(
      eq(sessions.sessionType, 'branch'),
      // Ordinary Agent roots count toward Project aggregates (see the doc
      // comment above). Internal-tree roots (peek/cron) are still rejected
      // by `sessionTreePredicate` below — this widens the session_type axis
      // only.
      eq(sessions.sessionType, 'root'),
      // Legacy IM adoption whitelist. Fully covered by the broader root
      // branch above; kept because host-channel-composition still writes the
      // marker and removing it would silently change this predicate's shape
      // for no behavioral gain.
      and(
        eq(sessions.sessionType, 'root'),
        eq(sessions.sessionKind, 'conversation'),
        trustedLegacyImRootPurposePredicate(),
      ),
    ),
    sessionTreePredicate(options),
  );
}

function trustedLegacyImRootPurposePredicate(): SQL {
  const markerLine = `\n${TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER}`;
  return or(
    eq(sessions.purpose, TRUSTED_LEGACY_IM_ROOT_PURPOSE_MARKER),
    sql`substr(${sessions.purpose}, -${markerLine.length}) = ${markerLine}`,
  )!;
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
