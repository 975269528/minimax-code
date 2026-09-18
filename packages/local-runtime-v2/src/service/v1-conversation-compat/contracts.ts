import type { ConversationRootReplacement } from '@mavis/conversation-contract';

import type {
  CommittedQueueCapability,
  MessageQueryService,
  MessageRepository,
  RootAgentPort,
  SessionLifecycleService,
  SessionQueryService,
  SessionRecord,
  SessionRecordService,
  SessionRepository,
} from '../session-system/index.js';
import type { TurnService } from '../turn-system/index.js';
import type { V1ConversationAttachmentMaterializer } from './attachments/index.js';
import type { V1CompatibleTurnSubmission } from './v1-compatible-turn-submission.service.js';

export interface V1ConversationCompatibilityOptions {
  readonly sessions: {
    readonly repository: Pick<
      SessionRepository,
      'get' | 'list' | 'listRootPage' | 'swapRoot' | 'reparentChildren'
    >;
    readonly query: Pick<SessionQueryService, 'find' | 'listExact'>;
    readonly records: Pick<SessionRecordService, 'discardCreatedSession'>;
    readonly lifecycle: Pick<
      SessionLifecycleService,
      'createSession' | 'createInternalSession' | 'createRootSession' | 'mutateSession'
    >;
    readonly messages: {
      readonly query: Pick<MessageQueryService, 'list'>;
      readonly repository: Pick<MessageRepository, 'listTurn' | 'upsert'>;
    };
    readonly queue: Pick<
      CommittedQueueCapability,
      'list' | 'findByClientRequestId' | 'update' | 'promote' | 'cancel' | 'reorder'
    >;
    readonly deletion: { deleteSession(sessionId: string): Promise<unknown> };
    readonly root: {
      getRootSessionByAgent(agentName: string): Promise<SessionRecord>;
      replaceRootSessionWithResult(
        agentName: string,
        sessionId: string,
      ): Promise<ConversationRootReplacement>;
    };
  };
  readonly submission: V1CompatibleTurnSubmission;
  readonly attachmentMaterializer: V1ConversationAttachmentMaterializer;
  readonly turns: Pick<TurnService, 'requestCompaction' | 'abort' | 'dispatchQueue'>;
  readonly rootAgents: RootAgentPort;
  readonly resolveAgentWriteTarget: (requestRef: string) => Promise<string>;
  readonly onQueueWakeFailure?: (input: {
    readonly sessionId: string;
    readonly itemId?: string;
    readonly error: unknown;
  }) => void;
}
