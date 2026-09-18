import type { SessionUsageInsert } from './contract.js';

export function validateUsageInsert(row: SessionUsageInsert): void {
  const values = [
    row.ts,
    row.inputTokens,
    row.outputTokens,
    row.reasoningTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError('Usage values must be non-negative safe integers');
  }
}
