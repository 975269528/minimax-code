import type { RuntimeConversation } from '@mavis/conversation-contract';

import type { SessionSystemOwner } from '../session-system/index.js';
import type { V1ConversationAttachmentRegistrationPort } from './attachments/index.js';
import { createV1ConversationAttachmentMaterializer } from './attachments/index.js';
import type { V1ConversationCompatibilityOptions } from './contracts.js';
import { createV1ConversationCompatibility } from './initialize.js';
import {
  createV1CompatibleTurnSubmission,
  type V1CompatibleTurnSubmissionOptions,
} from './v1-compatible-turn-submission.service.js';

/**
 * What the composition root supplies for one v1 Conversation surface.
 *
 * The Session and Turn owners come in whole because this is where they are
 * narrowed to the ports the surface actually reads. Everything else is a port
 * the surface cannot derive: Session lifecycle and Root sequencing live in the
 * Application layer, and queue-wake failures are reported by whoever owns the
 * failure sink.
 */
export interface V1ConversationComposition {
  readonly attachmentRegistration: V1ConversationAttachmentRegistrationPort;
  readonly sessions: SessionSystemOwner;
  readonly turns: V1CompatibleTurnSubmissionOptions['turns'] &
    V1ConversationCompatibilityOptions['turns'];
  readonly rootAgents: V1ConversationCompatibilityOptions['rootAgents'];
  readonly resolveAgentWriteTarget: V1ConversationCompatibilityOptions['resolveAgentWriteTarget'];
  readonly lifecycle: V1ConversationCompatibilityOptions['sessions']['lifecycle'];
  readonly deletion: { deleteSessionById(sessionId: string): Promise<unknown> };
  readonly root: V1ConversationCompatibilityOptions['sessions']['root'];
  readonly onQueueWakeFailure?: V1ConversationCompatibilityOptions['onQueueWakeFailure'];
}

/**
 * Assembles the three collaborators behind the v1 Conversation surface.
 *
 * The materializer is shared on purpose: submission registers attachments
 * before a Turn is accepted, and the compatibility service reuses the same
 * registration when it materializes a message on any other path.
 */
export function composeV1Conversation(input: V1ConversationComposition): RuntimeConversation {
  const attachmentMaterializer = createV1ConversationAttachmentMaterializer({
    registration: input.attachmentRegistration,
  });
  const submission = createV1CompatibleTurnSubmission({
    turns: input.turns,
    attachmentMaterializer,
  });
  return createV1ConversationCompatibility({
    sessions: {
      repository: input.sessions.sessions.repository,
      query: input.sessions.sessions.query,
      records: input.sessions.sessions.records,
      lifecycle: input.lifecycle,
      messages: { ...input.sessions.messages },
      queue: input.sessions.queue.committed,
      deletion: {
        deleteSession: (sessionId) => input.deletion.deleteSessionById(sessionId),
      },
      root: input.root,
    },
    submission,
    attachmentMaterializer,
    turns: input.turns,
    rootAgents: input.rootAgents,
    resolveAgentWriteTarget: input.resolveAgentWriteTarget,
    ...(input.onQueueWakeFailure ? { onQueueWakeFailure: input.onQueueWakeFailure } : {}),
  });
}
