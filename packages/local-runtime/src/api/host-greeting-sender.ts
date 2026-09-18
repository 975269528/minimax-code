import type { ConversationAcceptedTurn } from '@mavis/conversation-contract';
import type { LocalSessionRecord } from '../sessions/controller.js';

export interface LocalGreetingSystemReminderSenderOptions {
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
  submitConversationTurn(input: {
    sessionId: string;
    content: string;
    requestedTurnId: string;
  }): Promise<ConversationAcceptedTurn>;
}

export class LocalGreetingSystemReminderSender {
  constructor(private readonly options: LocalGreetingSystemReminderSenderOptions) {}

  async sendSystemReminder(input: {
    agentName: string;
    sessionId: string;
    content: string;
    requestedTurnId: string;
  }): Promise<'finished' | { readonly status: 'accepted'; readonly turnId: string }> {
    const session = await this.options.getSessionById(input.sessionId);
    if (!session || session.agentName !== input.agentName) {
      throw new Error(`Greeting session is unavailable for ${input.agentName}`);
    }
    const accepted = await this.options.submitConversationTurn({
      sessionId: input.sessionId,
      content: input.content,
      requestedTurnId: input.requestedTurnId,
    });
    return { status: 'accepted', turnId: accepted.turnId };
  }
}
