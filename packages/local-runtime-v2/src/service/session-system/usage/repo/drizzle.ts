import { and, asc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { tokenUsage } from '../../../../infra/db/schema/usage.js';
import type {
  SessionUsageRepository,
  SessionUsageRepositoryOptions,
  SessionUsageInsert,
  SessionUsageRow,
  UsageRange,
  UsageSummary,
} from './contract.js';
import { validateUsageInsert } from './policy.js';

export function createSessionUsageRepository(
  options: SessionUsageRepositoryOptions,
): SessionUsageRepository {
  return new DrizzleSessionUsageRepository(options);
}
class DrizzleSessionUsageRepository implements SessionUsageRepository {
  constructor(private readonly options: SessionUsageRepositoryOptions) {}
  async append(row: SessionUsageInsert) {
    validateUsageInsert(row);
    this.options.db.insert(tokenUsage).values(encode(row)).run();
  }
  async listBySession(sessionId: string, range?: UsageRange) {
    return this.options.db
      .select()
      .from(tokenUsage)
      .where(and(eq(tokenUsage.sessionId, sessionId), usageRangePredicate(range)))
      .orderBy(asc(tokenUsage.timestamp), asc(tokenUsage.id))
      .all()
      .map(decode);
  }
  async summarizeBySession(sessionId: string, range?: UsageRange) {
    return this.summarize(and(eq(tokenUsage.sessionId, sessionId), usageRangePredicate(range)));
  }
  async summarizeGlobal(range?: UsageRange) {
    return this.summarize(usageRangePredicate(range));
  }
  async summarizeGroupBy(group: 'agent' | 'session' | 'model' | 'day', range?: UsageRange) {
    const key = usageGroupExpression(group);
    return this.options.db
      .select({ key, ...usageSummarySelection() })
      .from(tokenUsage)
      .where(usageRangePredicate(range))
      .groupBy(key)
      .orderBy(asc(key))
      .all()
      .map((row) => ({ key: usageGroupKey(group, row.key), summary: summaryFromRow(row) }));
  }
  async deleteSession(sessionId: string) {
    this.options.db.delete(tokenUsage).where(eq(tokenUsage.sessionId, sessionId)).run();
  }
  private summarize(predicate: SQL | undefined): UsageSummary {
    const row = this.options.db
      .select(usageSummarySelection())
      .from(tokenUsage)
      .where(predicate)
      .get();
    return summaryFromRow(row ?? emptySummaryRow());
  }
}

function encode(row: SessionUsageInsert): typeof tokenUsage.$inferInsert {
  return {
    sessionId: row.sessionId,
    agentName: row.agentName,
    frameworkType: row.frameworkType,
    turnId: row.turnId,
    model: row.model,
    timestamp: row.ts,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    raw: row.raw,
  };
}

function decode(row: typeof tokenUsage.$inferSelect): SessionUsageRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentName: row.agentName,
    frameworkType: row.frameworkType,
    turnId: row.turnId,
    model: row.model,
    ts: row.timestamp,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: row.reasoningTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd,
    raw: row.raw,
  };
}
function usageRangePredicate(range?: UsageRange): SQL | undefined {
  return and(
    range?.from === undefined ? undefined : gte(tokenUsage.timestamp, range.from),
    range?.to === undefined ? undefined : lte(tokenUsage.timestamp, range.to),
  );
}

function usageGroupExpression(group: 'agent' | 'session' | 'model' | 'day'): SQL<string | number> {
  if (group === 'agent') return sql<string>`${tokenUsage.agentName}`;
  if (group === 'session') return sql<string>`${tokenUsage.sessionId}`;
  if (group === 'model') return sql<string>`coalesce(${tokenUsage.model}, 'unknown')`;
  return sql<number>`CAST(${tokenUsage.timestamp} / 86400000 AS INTEGER)`.mapWith(Number);
}

function usageGroupKey(
  group: 'agent' | 'session' | 'model' | 'day',
  value: string | number,
): string {
  if (group !== 'day') return String(value);
  const date = new Date(Number(value) * 86_400_000);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function usageSummarySelection() {
  return {
    inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)`.mapWith(Number),
    outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)`.mapWith(Number),
    reasoningTokens: sql<number>`coalesce(sum(${tokenUsage.reasoningTokens}), 0)`.mapWith(Number),
    cacheReadTokens: sql<number>`coalesce(sum(${tokenUsage.cacheReadTokens}), 0)`.mapWith(Number),
    cacheWriteTokens: sql<number>`coalesce(sum(${tokenUsage.cacheWriteTokens}), 0)`.mapWith(Number),
    costUsd: sql<number>`coalesce(sum(${tokenUsage.costUsd}), 0)`.mapWith(Number),
    turns: sql<number>`count(*)`.mapWith(Number),
  };
}

function emptySummaryRow() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
  };
}

function summaryFromRow(totals: ReturnType<typeof emptySummaryRow>): UsageSummary {
  return {
    ...totals,
    totalTokens: totals.inputTokens + totals.outputTokens + totals.reasoningTokens,
  };
}
