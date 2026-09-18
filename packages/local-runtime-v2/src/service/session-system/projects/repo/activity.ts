import { sql } from 'drizzle-orm';
import { projects } from '../../../../infra/db/schema/projects.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';

// The published v5 triggers own aggregates excluding Channel Sessions. Add Channel
// activity at read time so older builds can keep writing the same shared database.
// Keep the partial-index predicate explicit so SQLite can use the v6 project indexes.
export const channelProjectPredicate = sql`${sessions.projectId} = ${projects.projectId}
  AND ${sessions.columnarVersion} = 3 AND ${sessions.archived} = 0
  AND ${sessions.visibility} <> 'hidden' AND ${sessions.sessionKind} NOT IN ('peek', 'cron')
  AND ${sessions.sessionKind} = 'channel'`;
export const projectActivityExpression = sql<number>`MAX(${projects.latestActivityAtMs}, COALESCE(
  (SELECT MAX(${sessions.updatedAtMs}) FROM ${sessions} WHERE ${channelProjectPredicate}), 0))`;
