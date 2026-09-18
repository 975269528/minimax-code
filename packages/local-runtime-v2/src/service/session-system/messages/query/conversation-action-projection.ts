import { CURRENT_SESSION_DATA_VERSION } from '../../sessions/support/version.js';
import { isConversationMutationEligibleSession } from '../../sessions/support/conversation-mutation-eligibility.js';
import { isUserMessageId } from '../../shared/user-message-id.js';
import type { SessionOperationIntentRepository } from '../../mutation/operation-intent-contract.js';
import type { SessionRepository } from '../../sessions/repo/contract.js';
import type { DisplayMessageRecord, MessageRepository } from '../repo/contract.js';
import {
  isQuestionnaireResponseInput,
  isRewindableQuestionnaireResponseInput,
} from '../input-navigation/text.js';

export interface ConversationActionProjectionInput {
  readonly sessionId: string;
  readonly messages: readonly DisplayMessageRecord[];
  readonly mutationActive: boolean;
}

export interface ConversationActionProjectionServiceOptions {
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly messages: Pick<MessageRepository, 'list' | 'listTurn'>;
  readonly operations: Pick<SessionOperationIntentRepository, 'blocksSession'>;
  readonly availability?: {
    readPlanState(sessionId: string): Promise<{ readonly active: boolean }>;
  };
}

export interface ConversationMessageActions {
  readonly fork?: true;
  readonly rewind?: true;
}

export interface ConversationMessageActionDelta {
  readonly messageId: string;
  readonly actions: ConversationMessageActions;
}

type ConversationBoundary = 'assistant' | 'user' | undefined;

/** Projects ephemeral actions from authoritative Session + Display state; actions are never persisted. */
export class ConversationActionProjectionService {
  constructor(private readonly options: ConversationActionProjectionServiceOptions) {}

  async project(
    input: ConversationActionProjectionInput,
  ): Promise<readonly DisplayMessageRecord[]> {
    const page = input.messages.map(withoutActions);
    const context = await this.projectableSession(input.sessionId, input.mutationActive);
    if (!context) return page;

    const fullHistory = (await this.options.messages.list(input.sessionId)).messages;
    const actionsByMessageId = projectActions(
      fullHistory,
      context.session.status === 'idle',
      context.planActive,
    );
    return page.map((message) => {
      const messageId = typeof message.msg_id === 'string' ? message.msg_id : undefined;
      const actions = messageId ? actionsByMessageId.get(messageId) : undefined;
      return actions ? { ...message, actions } : message;
    });
  }

  async projectTerminalTurn(input: {
    readonly sessionId: string;
    readonly turnId: string;
  }): Promise<readonly ConversationMessageActionDelta[]> {
    const context = await this.projectableSession(input.sessionId, false);
    if (!context) return [];
    const turnMessages = await this.options.messages.listTurn(input.sessionId, input.turnId);
    const actionsByMessageId = projectActions(
      turnMessages,
      context.session.status === 'idle',
      context.planActive,
    );
    return turnMessages.flatMap((message) => {
      const messageId = typeof message.msg_id === 'string' ? message.msg_id : undefined;
      const actions = messageId ? actionsByMessageId.get(messageId) : undefined;
      return messageId && actions ? [{ messageId, actions }] : [];
    });
  }

  private async projectableSession(sessionId: string, mutationActive: boolean) {
    const session = await this.options.sessions.get(sessionId);
    if (
      !session ||
      !isConversationMutationEligibleSession(session, CURRENT_SESSION_DATA_VERSION) ||
      mutationActive ||
      (await this.options.operations.blocksSession(sessionId))
    ) {
      return undefined;
    }
    const planState = await this.options.availability?.readPlanState(sessionId);
    return { session, planActive: planState?.active === true };
  }
}

function projectActions(
  messages: readonly DisplayMessageRecord[],
  latestAssistantSettled: boolean,
  planActive: boolean,
): ReadonlyMap<string, ConversationMessageActions> {
  if (planActive) return projectPlanForkAction(messages, latestAssistantSettled);
  const result = new Map<string, ConversationMessageActions>();
  let nextBoundary: ConversationBoundary;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || isSpecial(message)) continue;
    const messageId = typeof message.msg_id === 'string' ? message.msg_id : undefined;
    if (isCommittedUserMessage(message, messageId)) {
      if (shouldProjectRewind(message)) result.set(messageId, { rewind: true });
      nextBoundary = 'user';
      continue;
    }
    if (message.role !== 'assistant') continue;
    if (canForkFrom(message, messageId, nextBoundary)) {
      result.set(messageId, { fork: true });
    }
    nextBoundary = 'assistant';
  }
  return result;
}

function projectPlanForkAction(
  messages: readonly DisplayMessageRecord[],
  latestAssistantSettled: boolean,
): ReadonlyMap<string, ConversationMessageActions> {
  if (!latestAssistantSettled) return new Map();
  const latest = messages.slice().reverse().find(isConversationMessage);
  const messageId = typeof latest?.msg_id === 'string' ? latest.msg_id : undefined;
  if (latest?.role !== 'assistant' || !messageId || isUnsettled(latest)) return new Map();
  return new Map([[messageId, { fork: true }]]);
}

function isCommittedUserMessage(
  message: DisplayMessageRecord,
  messageId: string | undefined,
): messageId is `msg-user-v1-${string}` {
  return message.role === 'user' && messageId !== undefined && isUserMessageId(messageId);
}

function canForkFrom(
  message: DisplayMessageRecord,
  messageId: string | undefined,
  nextBoundary: ConversationBoundary,
): messageId is string {
  if (!messageId || isInvalidForkAssistant(message)) return false;
  return nextBoundary === 'user' || nextBoundary === undefined;
}

function isSpecial(message: DisplayMessageRecord): boolean {
  return (
    (typeof message.kind === 'string' && message.kind.length > 0) ||
    (typeof message.displayKind === 'string' && message.displayKind.length > 0)
  );
}

function isConversationMessage(message: DisplayMessageRecord): boolean {
  return message.role === 'assistant' || isCommittedUserMessage(message, message.msg_id);
}

function isUnsettled(message: DisplayMessageRecord): boolean {
  return (
    message.source === 'optimistic' || message.source === 'streaming' || message.source === 'error'
  );
}

function shouldProjectRewind(message: DisplayMessageRecord): boolean {
  return (
    !isUnsettled(message) &&
    (!isQuestionnaireResponseInput(message) || isRewindableQuestionnaireResponseInput(message))
  );
}

function isInvalidForkAssistant(message: DisplayMessageRecord): boolean {
  return message.source === 'optimistic' || message.source === 'error';
}

function withoutActions(message: DisplayMessageRecord): DisplayMessageRecord {
  const copy = { ...message };
  delete copy.actions;
  return copy;
}
