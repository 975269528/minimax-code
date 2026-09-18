import { and, desc, eq } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { turnIngress } from '../../../infra/db/schema/turn.js';
import type { QueueCommittedFact } from '../../session-system/index.js';
import type { TurnRepositoryOptions } from './contracts.js';

export function publishQueueFacts(
  options: TurnRepositoryOptions,
  facts: readonly QueueCommittedFact[],
): void {
  try {
    options.priorityFence.publishCommitted(facts);
  } catch {
    // Queue facts project committed state best-effort; authoritative reads converge later.
  }
}

export function persistedTurnConsumesQueuePause(db: AppDb, sessionId: string): boolean {
  const row = db
    .select({ inputMetadataJson: turnIngress.inputMetadataJson })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .limit(1)
    .get();
  if (!row) return false;
  try {
    const metadata: unknown = JSON.parse(row.inputMetadataJson);
    return Boolean(
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      (metadata as Readonly<Record<string, unknown>>).consumeQueuePause === true,
    );
  } catch {
    return false;
  }
}
