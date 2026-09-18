import { lockSessionMemoryRecallInTransaction } from '../../service/session-system/index.js';
import type { TurnAdmissionPolicy } from '../../service/turn-system/index.js';

export function createMemoryRecallAdmissionPolicy(): TurnAdmissionPolicy {
  return {
    applyInTransaction(db, input) {
      if (!input.genuineUserMessage) return undefined;
      const result = lockSessionMemoryRecallInTransaction(db, {
        sessionId: input.sessionId,
        lockedAtMs: input.candidateCreatedAtMs,
      });
      return result === 'not-found' ? 'invalid-session' : undefined;
    },
  };
}
