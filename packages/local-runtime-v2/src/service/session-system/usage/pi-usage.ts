import type { SessionUsageInsert } from './repo/contract.js';
import type { SessionUsageStore } from './types.js';

export interface CommittedPiGoalUsageSummary {
  /** Fresh provider input, output, and reasoning tokens available on committed assistant messages. */
  readonly tokens: number;
  /** True when at least one committed assistant message omitted provider usage. */
  readonly incomplete: boolean;
}

/** Goal accounting counts every available fresh provider token, excluding cache counters. */
export function sumCommittedPiUsageTokens(messages: readonly unknown[]): number {
  return summarizeCommittedPiGoalUsage(messages).tokens;
}

/** Keep missing provider usage distinct from a trustworthy zero-cost turn. */
export function summarizeCommittedPiGoalUsage(
  messages: readonly unknown[],
): CommittedPiGoalUsageSummary {
  return messages.reduce<CommittedPiGoalUsageSummary>(
    (summary, message) => {
      if (!isAssistantMessage(message)) return summary;
      const usage = readAssistantUsage(message);
      if (!usage) return { ...summary, incomplete: true };
      const normalized = normalizePiUsage(usage);
      return {
        tokens:
          summary.tokens +
          normalized.inputTokens +
          normalized.outputTokens +
          normalized.reasoningTokens,
        incomplete: summary.incomplete,
      };
    },
    { tokens: 0, incomplete: false },
  );
}

export async function recordCommittedPiUsage(input: {
  readonly store: Pick<SessionUsageStore, 'append'>;
  readonly session: { readonly sessionId: string; readonly agentName: string };
  readonly turnId: string;
  readonly model?: string | null;
  readonly nowMs: () => number;
  readonly messages: readonly unknown[];
  readonly onFailure?: (failure: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly error: unknown;
  }) => void;
}): Promise<number> {
  let recorded = 0;
  try {
    for (const row of committedPiUsageRows(input)) {
      await input.store.append(row);
      recorded += 1;
    }
  } catch (error) {
    reportUsageFailure(input, error);
  }
  return recorded;
}

function committedPiUsageRows(input: {
  readonly session: { readonly sessionId: string; readonly agentName: string };
  readonly turnId: string;
  readonly model?: string | null;
  readonly nowMs: () => number;
  readonly messages: readonly unknown[];
}): readonly SessionUsageInsert[] {
  return input.messages.flatMap((message) => {
    const usage = readPiUsage(message);
    return usage
      ? [
          {
            sessionId: input.session.sessionId,
            agentName: input.session.agentName,
            frameworkType: 'pi-agent',
            turnId: input.turnId,
            model: input.model ?? null,
            ts: readTimestamp(message) ?? input.nowMs(),
            ...usage,
          },
        ]
      : [];
  });
}

function reportUsageFailure(
  input: {
    readonly session: { readonly sessionId: string };
    readonly turnId: string;
    readonly onFailure?: (failure: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly error: unknown;
    }) => void;
  },
  error: unknown,
): void {
  try {
    input.onFailure?.({
      sessionId: input.session.sessionId,
      turnId: input.turnId,
      error,
    });
  } catch {
    // Usage is a best-effort projection after the canonical history commit.
  }
}

interface PiUsageShape {
  readonly input?: unknown;
  readonly output?: unknown;
  readonly reasoning?: unknown;
  readonly cacheRead?: unknown;
  readonly cacheWrite?: unknown;
  readonly cache?: { readonly read?: unknown; readonly write?: unknown };
  readonly cache_read?: unknown;
  readonly cache_write?: unknown;
  readonly total_tokens?: unknown;
  readonly cost?: { readonly total?: unknown };
}

interface NormalizedPiUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

function readPiUsage(
  message: unknown,
):
  | (NormalizedPiUsage & { readonly costUsd: number | null; readonly raw: string | null })
  | undefined {
  const usage = readAssistantUsage(message);
  if (!usage) return undefined;
  const normalized = normalizePiUsage(usage);
  if (!hasUsage(normalized)) return undefined;
  return { ...normalized, costUsd: readCostUsd(usage), raw: safeJson(usage) };
}

function readAssistantUsage(message: unknown): PiUsageShape | undefined {
  if (!isAssistantMessage(message)) return undefined;
  const rawUsage = Reflect.get(message, 'usage');
  if (!rawUsage || typeof rawUsage !== 'object') return undefined;
  return rawUsage as PiUsageShape;
}

function isAssistantMessage(message: unknown): message is object {
  return Boolean(
    message && typeof message === 'object' && Reflect.get(message, 'role') === 'assistant',
  );
}

function normalizePiUsage(usage: PiUsageShape): NormalizedPiUsage {
  const piInput = numericValue(usage.input);
  const piOutput = numericValue(usage.output);
  const inputTokens = piInput > 0 || piOutput > 0 ? piInput : numericValue(usage.total_tokens);
  const outputTokens = piInput > 0 || piOutput > 0 ? piOutput : 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: numericValue(usage.reasoning),
    cacheReadTokens: numericValue(usage.cacheRead ?? usage.cache?.read ?? usage.cache_read),
    cacheWriteTokens: numericValue(usage.cacheWrite ?? usage.cache?.write ?? usage.cache_write),
  };
}

function hasUsage(usage: NormalizedPiUsage): boolean {
  return (
    usage.inputTokens +
      usage.outputTokens +
      usage.reasoningTokens +
      usage.cacheReadTokens +
      usage.cacheWriteTokens !==
    0
  );
}

function readCostUsd(usage: PiUsageShape): number | null {
  return typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total)
    ? usage.cost.total
    : null;
}

function readTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const value = Reflect.get(message, 'timestamp') ?? Reflect.get(message, 'created_at');
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function numericValue(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}
