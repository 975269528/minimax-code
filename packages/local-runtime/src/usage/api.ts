import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';

import type {
  LocalTokenUsageGroupBy,
  LocalTokenUsageRow,
  LocalTokenUsageStore,
} from '../persistence/ports.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { LocalAgentContractError } from '../agent/contract.js';
import { json } from '../api/host-helpers.js';

const VALID_GROUP_BY = new Set<LocalTokenUsageGroupBy>(['agent', 'session', 'model', 'day']);

/**
 * Read-only resolver seam for external AgentName filters. The resolver owns
 * canonical/legacy compatibility and may return a singleton for `agent:`
 * explicit names; usage storage remains exact-keyed.
 */
export interface LocalUsageAgentResolver {
  resolveAgentReadScope(requestedName: string): Promise<{
    canonicalName: string;
    compatibleNames: readonly string[];
  }>;
}

export async function routeLocalUsageSummaryApi(input: {
  usageStore: LocalTokenUsageStore;
  url: URL;
  agentResolver?: LocalUsageAgentResolver;
}): Promise<Response> {
  const range = parseUsageRange(input.url);
  const groupBy = parseUsageGroupBy(input.url.searchParams.get('group'));
  const agentNames = await resolveUsageAgentNames(input.url, input.agentResolver);
  const filter = agentNames === undefined ? range : { ...range, agentNames };
  const summary = await input.usageStore.summarizeGlobal(filter);
  if (!groupBy) return json({ summary });
  const groups = await input.usageStore.summarizeGroupBy(groupBy, filter);
  return json({ summary, groups });
}

/**
 * Handler for the production `/agent/:name/usage` ingress. The host route
 * supplies the path name and resolver; this module keeps compatibility reads
 * in one `IN (...)` store query while preserving exact row owners/group keys.
 */
export async function routeLocalAgentUsageApi(input: {
  usageStore: LocalTokenUsageStore;
  agentName: string;
  url: URL;
  agentResolver: LocalUsageAgentResolver;
}): Promise<Response> {
  const range = parseUsageRange(input.url);
  const groupBy = parseUsageGroupBy(input.url.searchParams.get('group'));
  const scope = await input.agentResolver.resolveAgentReadScope(input.agentName);
  const agentNames = normalizeUsageAgentNames(scope.compatibleNames, scope.canonicalName);
  const filter = { ...range, agentNames };
  const summary = await input.usageStore.summarizeByAgent(scope.canonicalName, filter);
  if (groupBy) {
    const groups = await input.usageStore.summarizeGroupBy(groupBy, filter);
    return json({ summary, groups });
  }
  const rows = await input.usageStore.listByAgent(scope.canonicalName, {
    ...filter,
  });
  return json({ summary, rows });
}

export async function routeLocalSessionUsageApi(input: {
  usageStore: LocalTokenUsageStore;
  sessionId: string;
}): Promise<Response> {
  const [summary, rows] = await Promise.all([
    input.usageStore.summarizeBySession(input.sessionId),
    input.usageStore.listBySession(input.sessionId),
  ]);
  return json({ summary, rows });
}

export async function recordLocalTokenUsageFromPiMessages(input: {
  usageStore: LocalTokenUsageStore;
  session: LocalSessionRecord;
  turnId: string;
  model?: string | null;
  nowMs: () => number;
  messages: PiAgentMessage[];
}): Promise<void> {
  for (const message of input.messages) {
    const usage = readPiUsage(message);
    if (!usage) continue;
    await input.usageStore.append({
      sessionId: input.session.sessionId,
      agentName: input.session.agentName,
      frameworkType: 'pi-agent',
      turnId: input.turnId,
      model: input.model ?? null,
      ts: readMessageTimestamp(message) ?? input.nowMs(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      costUsd: usage.costUsd ?? null,
      raw: JSON.stringify(usage.raw),
    });
  }
}

/**
 * Sum the per-turn billable tokens that count against `token_budget`
 * across a batch of Pi messages (e.g. one `onHistoryChangedHook` delta
 * or the full per-turn flush).
 *
 *   delta = input + output
 *
 * `pi-ai` Messages-compatible provider writes `usage.input` verbatim from
 * the provider SSE `input_tokens` field, which per the wire
 * protocol is "fresh input AFTER the last cache breakpoint" — already
 * disjoint from `cache_read_input_tokens` and `cache_creation_input_tokens`.
 * pi-ai's own `totalTokens = input + output + cacheRead + cacheWrite`
 * (provider implementation) only adds up correctly when the four are
 * disjoint, which is the additional proof.
 *
 * IMPORTANT — DO NOT subtract `cacheRead` here. Codex's
 * `goal_token_delta_for_usage` (`ext/goal/src/accounting.rs:328`)
 * subtracts `cached_input_tokens` because codex's `TokenUsage.input_tokens`
 * comes from OpenAI Responses, where `input_tokens` is a TOTAL that
 * INCLUDES cached. The Messages-compatible provider + pi-ai's `usage.input` is the opposite
 * shape — already fresh — so subtracting cacheRead here would
 * double-undercount and clamp the entire fresh input to zero on any
 * cache-heavy turn (verified against prod gateway:
 * `{input_tokens:42, cache_read_input_tokens:128, output_tokens:2}`
 * billable = 44, NOT 2).
 *
 * `cacheWrite` is NOT added either — the provider charges 1.25× for cache
 * creation, but the multiplier lives in pricing, not in token counts;
 * counting them 1:1 with input here would over-charge for normal turns
 * vs cache-write turns. If pricing-accurate accounting is needed later,
 * compute it from `usage.cacheWriteTokens` in a separate pass.
 *
 * Used by {@link LocalApiHost.recordThreadGoalTurnAccounting} (Thread
 * Goal accounting, MR-1). Caller is responsible for accumulating across
 * a turn's worth of `onHistoryChangedHook` deltas.
 */
export function sumPiTurnUsageTokens(messages: PiAgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const usage = readPiUsage(message);
    if (!usage) continue;
    total += usage.inputTokens + usage.outputTokens;
  }
  return total;
}

function parseUsageRange(url: URL): { from?: number; to?: number } {
  const from = parseTimestampQuery(url.searchParams.get('from'), 'from');
  const to = parseTimestampQuery(url.searchParams.get('to'), 'to');
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error(`Invalid range: from (${String(from)}) > to (${String(to)})`);
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
  };
}

async function resolveUsageAgentNames(
  url: URL,
  resolver: LocalUsageAgentResolver | undefined,
): Promise<readonly string[] | undefined> {
  const requestedName = url.searchParams.get('agentName') ?? url.searchParams.get('agent');
  if (requestedName === null) return undefined;
  if (!resolver) {
    throw new LocalAgentContractError(
      503,
      'Agent read resolver is unavailable',
      'AGENT_RESOLVER_UNAVAILABLE',
    );
  }
  const scope = await resolver.resolveAgentReadScope(requestedName);
  return normalizeUsageAgentNames(scope.compatibleNames, scope.canonicalName);
}

function normalizeUsageAgentNames(
  compatibleNames: readonly string[] | undefined,
  canonicalName: string,
): readonly string[] {
  const names = compatibleNames?.length ? compatibleNames : [canonicalName];
  return [...new Set(names)].filter((name) => name.length > 0);
}

function parseTimestampQuery(value: string | null, paramName: string): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid query param ${paramName}: "${value}"`);
  }
  return parsed;
}

function parseUsageGroupBy(value: string | null): LocalTokenUsageGroupBy | undefined {
  if (value === null || value === '') return undefined;
  if (!VALID_GROUP_BY.has(value as LocalTokenUsageGroupBy)) {
    throw new Error(`Invalid group "${value}"`);
  }
  return value as LocalTokenUsageGroupBy;
}

function readPiUsage(
  message: PiAgentMessage,
):
  | (Omit<
      LocalTokenUsageRow,
      'id' | 'sessionId' | 'agentName' | 'frameworkType' | 'turnId' | 'model' | 'ts' | 'raw'
    > & { raw: unknown })
  | undefined {
  const record = message as { role?: unknown; usage?: unknown };
  if (record.role !== 'assistant') return undefined;
  if (!record.usage || typeof record.usage !== 'object') return undefined;
  const usage = record.usage as {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cache?: { read?: unknown; write?: unknown };
    cost?: { total?: unknown };
    total_tokens?: unknown;
    cache_read?: unknown;
    cache_write?: unknown;
  };
  const piInput = numericOrZero(usage.input);
  const piOutput = numericOrZero(usage.output);
  const reasoningTokens = numericOrZero(usage.reasoning);
  const cacheReadTokens = numericOrZero(usage.cacheRead ?? usage.cache?.read ?? usage.cache_read);
  const cacheWriteTokens = numericOrZero(
    usage.cacheWrite ?? usage.cache?.write ?? usage.cache_write,
  );
  const protocolTotal = numericOrZero(usage.total_tokens);
  const inputTokens = piInput > 0 || piOutput > 0 ? piInput : protocolTotal;
  const outputTokens = piInput > 0 || piOutput > 0 ? piOutput : 0;
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheWriteTokens === 0
  ) {
    return undefined;
  }
  const costUsd =
    typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total)
      ? usage.cost.total
      : undefined;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: costUsd ?? null,
    raw: record.usage,
  };
}

function readMessageTimestamp(message: PiAgentMessage): number | undefined {
  const record = message as { timestamp?: unknown; created_at?: unknown };
  return numericOrUndefined(record.timestamp ?? record.created_at);
}

function numericOrZero(value: unknown): number {
  return numericOrUndefined(value) ?? 0;
}

function numericOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
