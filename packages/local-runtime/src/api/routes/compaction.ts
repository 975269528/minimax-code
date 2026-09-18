import type { RuntimeConversation } from '@mavis/conversation-contract';

import { json } from '../host-helpers.js';
import type { LocalSessionRecord } from '../../sessions/controller.js';

/**
 * V2-owned manual-compaction result, retained as the Channel transport's
 * stable response shape.
 */
export interface CompactionOutcome {
  success: boolean;
  code: string;
  status: number;
  sessionId?: string;
  compactionId?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  error?: string;
}

/**
 * Compatibility HTTP adapter only. Compaction execution belongs to the
 * injected V2 Conversation maintenance owner.
 */
export async function requestConversationCompaction(
  conversation: Pick<RuntimeConversation, 'maintenance'>,
  session: LocalSessionRecord,
  body: Record<string, unknown>,
): Promise<Response> {
  const outcome = await conversation.maintenance.compact({
    sessionId: session.sessionId,
    agentName: session.agentName,
    ...(readOptionalString(body.customInstructions)
      ? { customInstructions: readOptionalString(body.customInstructions) }
      : {}),
    ...(readOptionalString(body.reason) ? { reason: readOptionalString(body.reason) } : {}),
  });
  return json(compactionOutcomeToResponseBody(outcome), { status: outcome.status });
}

function compactionOutcomeToResponseBody(outcome: CompactionOutcome): Record<string, unknown> {
  if (outcome.success) {
    return {
      success: true,
      sessionId: outcome.sessionId,
      compactionId: outcome.compactionId,
      messagesBefore: outcome.messagesBefore,
      messagesAfter: outcome.messagesAfter,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
    };
  }
  return {
    success: false,
    error: outcome.error,
    code: outcome.code,
  };
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
