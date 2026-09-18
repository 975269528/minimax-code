import { eq } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { legacyMessages, messageRowMigrations } from '../../../../infra/db/schema/messages.js';
import { MessageDataCorruptionError } from './contract.js';
import type { DisplayMessageRecord } from './contract.js';

/** Lazy legacy display materialization seam consumed by display readers such as Peek. */
export interface MessageDisplayReadiness {
  ensureDisplayReady(sessionId: string): Promise<void>;
}

export function ensureMessageRowsReadyInTransaction(
  db: AppDb,
  sessionId: string,
  nowMs: number,
  write: (message: DisplayMessageRecord, index: number) => void,
): void {
  const marker = db
    .select()
    .from(messageRowMigrations)
    .where(eq(messageRowMigrations.sessionId, sessionId))
    .get();
  if (marker) return;
  const source = db
    .select()
    .from(legacyMessages)
    .where(eq(legacyMessages.sessionId, sessionId))
    .get();
  const messages = source ? parseLegacyMessages(source.displayMessagesJson, sessionId) : [];
  messages.forEach(write);
  db.insert(messageRowMigrations)
    .values({ sessionId, displayRowsBackfilledAtMs: nowMs })
    .onConflictDoNothing()
    .run();
  if (source) {
    db.update(legacyMessages)
      .set({ displayMessagesJson: '[]' })
      .where(eq(legacyMessages.sessionId, sessionId))
      .run();
  }
}

function parseLegacyMessages(raw: string, sessionId: string): DisplayMessageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MessageDataCorruptionError(sessionId, 'legacy-display-blob');
  }
  if (!Array.isArray(parsed) || !parsed.every(isObject)) {
    throw new MessageDataCorruptionError(sessionId, 'legacy-display-blob');
  }
  return parsed;
}
function isObject(value: unknown): value is DisplayMessageRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
