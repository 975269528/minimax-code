import type {
  SessionUsageGroup,
  SessionUsageRow,
  SessionUsageStore,
  SessionUsageSummary,
} from './types.js';

export type SessionUsageFailureReason =
  | 'invalid-from'
  | 'invalid-to'
  | 'invalid-range'
  | 'invalid-group';

export class SessionUsageServiceError extends Error {
  constructor(
    readonly reason: SessionUsageFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SessionUsageServiceError';
  }
}

export interface SessionUsageReadInput {
  readonly sessionId: string;
  readonly from?: number;
  readonly to?: number;
}

export interface SessionUsageGlobalInput {
  readonly from?: number;
  readonly to?: number;
  readonly group?: string;
}

export interface SessionUsageReadResult {
  readonly summary: SessionUsageSummary;
  readonly rows: readonly SessionUsageRow[];
}

export interface SessionUsageGlobalResult {
  readonly summary: SessionUsageSummary;
  readonly groups?: readonly {
    readonly key: string;
    readonly summary: SessionUsageSummary;
  }[];
}

type SessionUsageQueryStore = Pick<
  SessionUsageStore,
  'listBySession' | 'summarizeBySession' | 'summarizeGlobal' | 'summarizeGroupBy'
>;

export class SessionUsageService {
  constructor(private readonly store: SessionUsageQueryStore) {}

  async summarizeSession(input: SessionUsageReadInput): Promise<SessionUsageSummary> {
    return this.store.summarizeBySession(input.sessionId, normalizeRange(input.from, input.to));
  }

  async readSession(input: SessionUsageReadInput): Promise<SessionUsageReadResult> {
    const range = normalizeRange(input.from, input.to);
    const [summary, rows] = await Promise.all([
      this.store.summarizeBySession(input.sessionId, range),
      this.store.listBySession(input.sessionId, range),
    ]);
    return { summary, rows };
  }

  async summarizeGlobal(input: SessionUsageGlobalInput): Promise<SessionUsageGlobalResult> {
    const range = normalizeRange(input.from, input.to);
    const group = normalizeGroup(input.group);
    const summary = await this.store.summarizeGlobal(range);
    return group
      ? { summary, groups: await this.store.summarizeGroupBy(group, range) }
      : { summary };
  }
}

function normalizeRange(fromValue: number | undefined, toValue: number | undefined) {
  const from = optionalTimestamp(fromValue, 'from');
  const to = optionalTimestamp(toValue, 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new SessionUsageServiceError(
      'invalid-range',
      `Invalid usage range: from (${String(from)}) > to (${String(to)})`,
    );
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

function optionalTimestamp(value: number | undefined, name: 'from' | 'to'): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionUsageServiceError(
      name === 'from' ? 'invalid-from' : 'invalid-to',
      `Invalid usage ${name} timestamp: ${String(value)}`,
    );
  }
  return value;
}

function normalizeGroup(value: string | undefined): SessionUsageGroup | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'agent' || value === 'session' || value === 'model' || value === 'day') {
    return value;
  }
  throw new SessionUsageServiceError('invalid-group', `Invalid usage group: ${value}`);
}
