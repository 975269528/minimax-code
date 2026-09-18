/**
 * Shared tiny utilities lifted from `feishu-adapter.ts` to keep the adapter
 * file under the 500-line layout budget. Pure functions only — no side
 * effects, no I/O. Anything that touches the store or the sender stays in
 * the adapter itself.
 */

import type { LocalFeishuBindingRecord } from '../../feishu.js';

/** A disabled, disconnected, or historical mock row is not a live transport. */
export function isUsableFeishuBinding(
  record: LocalFeishuBindingRecord | undefined,
): record is LocalFeishuBindingRecord & {
  enabled: true;
  connected: true;
  mode: 'webhook' | 'websocket';
} {
  if (!record?.enabled || !record.connected || record.mode === 'mock') return false;
  return Boolean(record.appId.trim() && record.appSecret.trim());
}

export function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** Bind-time modes are real transports only. Historical mock records are
 * normalised by the persisted-store reader and remain disabled there. */
export function normalizeMode(value: string | undefined): 'webhook' | 'websocket' {
  const normalized = value?.toLowerCase().trim();
  if (normalized === 'webhook') return 'webhook';
  if (normalized === 'websocket' || normalized === 'ws') return 'websocket';
  return 'websocket';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
