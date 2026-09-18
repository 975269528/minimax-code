import type { AppDb } from '../../../infra/db/client.js';
import type { SessionOperationIntentRepository } from './operation-intent-contract.js';

interface ConversationMutationPlanState {
  readonly active: boolean;
  readonly interactionMode: 'default' | 'plan' | undefined;
  readonly lifecycleActive: boolean;
}

export interface ConversationMutationState {
  isActive(sessionId: string): boolean;
  readPlanState(sessionId: string): Promise<ConversationMutationPlanState>;
  bindPlanStateReader(reader: (sessionId: string) => Promise<ConversationMutationPlanState>): void;
}

export function createConversationMutationState(
  db: AppDb,
  operations: SessionOperationIntentRepository,
): ConversationMutationState {
  let planStateReader: ((sessionId: string) => Promise<ConversationMutationPlanState>) | undefined;
  return {
    isActive: (sessionId: string) => operations.blocksSessionInTransaction(db, sessionId),
    readPlanState: async (sessionId: string): Promise<ConversationMutationPlanState> =>
      (await planStateReader?.(sessionId)) ?? {
        active: false,
        interactionMode: undefined,
        lifecycleActive: false,
      },
    bindPlanStateReader: (next: (sessionId: string) => Promise<ConversationMutationPlanState>) => {
      planStateReader = next;
    },
  };
}
