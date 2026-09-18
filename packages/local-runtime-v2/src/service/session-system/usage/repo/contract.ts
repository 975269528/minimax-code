import type { AppDb } from '../../../../infra/db/client.js';

export interface SessionUsageInsert {
  readonly sessionId: string;
  readonly agentName: string;
  readonly frameworkType: string;
  readonly turnId: string | null;
  readonly model: string | null;
  readonly ts: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number | null;
  readonly raw: string | null;
}
export interface SessionUsageRow extends SessionUsageInsert {
  readonly id: number;
}
export interface UsageRange {
  readonly from?: number;
  readonly to?: number;
}
export interface UsageSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
  readonly turns: number;
}
export interface UsageGroupSummary {
  readonly key: string;
  readonly summary: UsageSummary;
}

export interface SessionUsageRepository {
  append(row: SessionUsageInsert): Promise<void>;
  listBySession(sessionId: string, range?: UsageRange): Promise<SessionUsageRow[]>;
  summarizeBySession(sessionId: string, range?: UsageRange): Promise<UsageSummary>;
  summarizeGlobal(range?: UsageRange): Promise<UsageSummary>;
  summarizeGroupBy(
    group: 'agent' | 'session' | 'model' | 'day',
    range?: UsageRange,
  ): Promise<readonly UsageGroupSummary[]>;
  deleteSession(sessionId: string): Promise<void>;
}
export interface SessionUsageRepositoryOptions {
  readonly db: AppDb;
}
