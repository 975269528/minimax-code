import type {
  SessionUsageRepository,
  SessionUsageRow,
  UsageRange,
  UsageSummary,
} from './repo/contract.js';

export type SessionUsageGroup = 'agent' | 'session' | 'model' | 'day';
export type SessionUsageRange = UsageRange;
export type SessionUsageSummary = UsageSummary;
export type SessionUsageStore = SessionUsageRepository;
export type { SessionUsageRow };
