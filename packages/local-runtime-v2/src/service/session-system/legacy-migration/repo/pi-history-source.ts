import { asc, eq } from 'drizzle-orm';

import { decodeCanonicalHistoryEnvelope } from '../../../../infra/file/canonical-history.js';
import { legacyPiHistoryRows } from '../../../../infra/db/schema/legacy-session.js';
import { legacyMessages } from '../../../../infra/db/schema/messages.js';
import {
  isCanonicalEnvelopeShape,
  normalizeLegacyHistoryTimestamp,
} from '../legacy-history-timestamp.js';
import type { LegacyHistorySourceReader, LegacyHistorySourceReaderOptions } from './contract.js';

export function createLegacyHistorySourceReader(
  options: LegacyHistorySourceReaderOptions,
): LegacyHistorySourceReader {
  return new DrizzleLegacyHistorySourceReader(options);
}
class DrizzleLegacyHistorySourceReader implements LegacyHistorySourceReader {
  constructor(private readonly options: LegacyHistorySourceReaderOptions) {}
  async readLedgerSnapshot(sessionId: string) {
    return this.options.readLedgerSnapshot(sessionId);
  }
  async readSqliteRows(sessionId: string) {
    let rows: (typeof legacyPiHistoryRows.$inferSelect)[];
    try {
      rows = this.options.db
        .select()
        .from(legacyPiHistoryRows)
        .where(eq(legacyPiHistoryRows.sessionId, sessionId))
        .orderBy(asc(legacyPiHistoryRows.id))
        .all();
    } catch (error) {
      if (missingTable(error, 'local_runtime_pi_history_rows')) return [];
      throw error;
    }
    return rows.map((row) =>
      parseLegacyValue(
        row.dataJson,
        String(row.id),
        `legacy-row-${String(row.id)}`,
        row.createdAtMs,
      ),
    );
  }
  async readSqliteBlob(sessionId: string) {
    const row = this.options.db
      .select()
      .from(legacyMessages)
      .where(eq(legacyMessages.sessionId, sessionId))
      .get();
    if (!row) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.piHistoryJson);
    } catch {
      throw new Error(`Legacy Pi History blob is corrupt: ${sessionId}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`Legacy Pi History blob is corrupt: ${sessionId}`);
    return parsed.map((value, index) =>
      decodeLegacyValue(
        value,
        `msg-legacy-blob-${String(index + 1)}`,
        `legacy-blob-${String(index + 1)}`,
      ),
    );
  }
}
function parseLegacyValue(raw: string, messageId: string, turnId: string, stableFallback: number) {
  try {
    return decodeLegacyValue(JSON.parse(raw) as unknown, messageId, turnId, stableFallback);
  } catch (error) {
    throw new Error('Legacy Pi History row is corrupt', { cause: error });
  }
}
function decodeLegacyValue(
  value: unknown,
  fallbackMessageId: string,
  fallbackTurnId: string,
  stableFallback?: number,
) {
  const normalized = normalizeLegacyHistoryTimestamp(value, stableFallback);
  try {
    return decodeCanonicalHistoryEnvelope(normalized);
  } catch (envelopeError) {
    return decodeWrappedLegacyValue(normalized, fallbackMessageId, fallbackTurnId, envelopeError);
  }
}
function decodeWrappedLegacyValue(
  value: unknown,
  fallbackMessageId: string,
  fallbackTurnId: string,
  envelopeError: unknown,
) {
  const record = isRecord(value) ? value : {};
  try {
    return decodeCanonicalHistoryEnvelope({
      message_id: legacyMessageId(record, fallbackMessageId),
      turn_id: nonEmptyString(record.turn_id ?? record.turnId) ?? fallbackTurnId,
      message: value,
    });
  } catch (wrappedError) {
    throw isCanonicalEnvelopeShape(record) ? envelopeError : wrappedError;
  }
}
function legacyMessageId(record: Record<string, unknown>, fallback: string) {
  const candidate = record.message_id ?? record.messageId ?? record.id;
  return validMessageId(candidate) ? candidate : fallback;
}
function missingTable(error: unknown, table: string) {
  return error instanceof Error && error.message === `no such table: ${table}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:msg-.+|\d+)$/u.test(value);
}
function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
