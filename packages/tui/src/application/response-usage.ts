import type { TuiMessage } from '../runtime/stream-events.js';
import type { TuiTurnResponseUsage, TuiTurnRunUsage } from './turn-run-outcome.js';

const USAGE_FIELDS = [
  'totalTokens',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;

/** Compaction display markers do not expose their auxiliary provider usage here. */
export function isTurnCompactionMessage(message: TuiMessage, turnId: string): boolean {
  return (
    message.role === 'assistant' &&
    (message.turnId === undefined || message.turnId === turnId) &&
    message.kind?.startsWith('compaction') === true
  );
}

export function responseUsageFromMessage(
  message: TuiMessage,
  turnId: string,
): TuiTurnResponseUsage | undefined {
  if (
    message.role !== 'assistant' ||
    (message.turnId !== undefined && message.turnId !== turnId) ||
    isTurnCompactionMessage(message, turnId)
  )
    return undefined;
  const usage = Object.fromEntries(
    USAGE_FIELDS.flatMap((key) =>
      isTokenCount(message.usage?.[key]) ? [[key, message.usage?.[key]]] : [],
    ),
  );
  const invalidUsage = USAGE_FIELDS.some(
    (key) => message.usage?.[key] !== undefined && !isTokenCount(message.usage?.[key]),
  );
  return {
    ...(message.id?.trim() ? { messageId: message.id } : {}),
    ...(Object.keys(usage).length ? { usage } : {}),
    ...(invalidUsage ? { usageIncomplete: true } : {}),
  };
}

/** Corrections replace known fields; a sparse later projection cannot erase a bucket. */
export function upsertResponseUsage(
  responses: TuiTurnResponseUsage[],
  response: TuiTurnResponseUsage,
): void {
  const index = response.messageId
    ? responses.findIndex((candidate) => candidate.messageId === response.messageId)
    : -1;
  const previous = responses[index];
  if (!previous) {
    responses.push(response);
    return;
  }
  responses[index] = {
    ...previous,
    ...response,
    ...(previous.usage || response.usage
      ? { usage: { ...previous.usage, ...response.usage } }
      : {}),
  };
}

export function sumResponseUsage(responses: readonly TuiTurnResponseUsage[]): {
  usage?: TuiTurnRunUsage;
  usageIncomplete: boolean;
} {
  let usageIncomplete =
    responses.length === 0 ||
    responses.some(
      (response) =>
        !isTokenCount(response.usage?.inputTokens) ||
        !isTokenCount(response.usage?.outputTokens) ||
        response.usageIncomplete,
    );
  const usage = Object.fromEntries(
    USAGE_FIELDS.flatMap((key) => {
      const values = responses.map((response) => response.usage?.[key]).filter(isTokenCount);
      if (!values.length) return [];
      const sum = values.reduce((accumulated, value) => accumulated + value, 0);
      if (!Number.isFinite(sum)) {
        usageIncomplete = true;
        return [];
      }
      return [[key, sum]];
    }),
  );
  return { ...(Object.keys(usage).length ? { usage } : {}), usageIncomplete };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
