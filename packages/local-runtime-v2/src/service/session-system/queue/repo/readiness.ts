import { eq } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { queueRowMigrations } from '../../../../infra/db/schema/queue.js';

export function ensureQueueRowsReadyInTransaction(
  db: AppDb,
  sessionId: string,
  nowMs: number,
): void {
  const marker = db
    .select()
    .from(queueRowMigrations)
    .where(eq(queueRowMigrations.sessionId, sessionId))
    .get();
  if (marker) return;
  db.insert(queueRowMigrations)
    .values({ sessionId, queueRowsBackfilledAtMs: nowMs })
    .onConflictDoNothing()
    .run();
}
