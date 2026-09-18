import type { RuntimeEvent } from '@mavis/agent-core/protocol';
import type {
  ConversationChannelContext,
  ConversationCommittedMessage,
} from '@mavis/conversation-contract';

import type { DisplayMessageRecord, MessageSourceRecord } from '../session-system/index.js';

interface ChannelFinalReplyDelivery {
  deliver(input: {
    readonly channelContext: ConversationChannelContext;
    readonly sessionId: string;
    readonly messages: readonly ConversationCommittedMessage[];
    readonly workspaceDir?: string;
    readonly error?: string;
  }): Promise<void>;
}

interface ChannelTypingDelivery {
  start(input: {
    readonly channelContext: ConversationChannelContext;
    readonly sessionId: string;
  }): Promise<void>;
  end(input: {
    readonly channelContext: ConversationChannelContext;
    readonly sessionId: string;
  }): Promise<void>;
}

interface ChannelSystemProductCapabilities {
  readonly finalReplies: ChannelFinalReplyDelivery;
  readonly typing: ChannelTypingDelivery;
}

interface ChannelFinalReplyMessageSource {
  listTurn(sessionId: string, turnId: string): Promise<DisplayMessageRecord[]>;
  resolveTurnSource(sessionId: string, turnId: string): Promise<MessageSourceRecord | undefined>;
}

interface ChannelFinalReplySessionSource {
  get(sessionId: string): Promise<{ readonly workspaceDir: string } | undefined>;
}

export interface ChannelReplyEventContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly provenance?: {
    readonly source: string;
    readonly routingFingerprint?: string;
    readonly sourceContext?: Readonly<Record<string, unknown>>;
  };
}

export interface ChannelTurnExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly provenance: {
    readonly source: string;
    readonly routingFingerprint?: string;
    readonly sourceContext?: Readonly<Record<string, unknown>>;
  };
}

export interface ChannelTurnExecutionLifecycle {
  beforeExecution(input: ChannelTurnExecutionContext): Promise<void>;
  end(input: Pick<ChannelTurnExecutionContext, 'sessionId' | 'turnId'>): Promise<void>;
}

interface ChannelTerminalReplyObserver {
  observeRuntimeEvent(input: {
    readonly context: ChannelReplyEventContext;
    readonly event: RuntimeEvent;
  }): Promise<void>;
}

export interface ChannelFinalReplyObserverOptions {
  readonly messages: ChannelFinalReplyMessageSource;
  readonly sessions: ChannelFinalReplySessionSource;
  readonly delivery: ChannelFinalReplyDelivery;
  readonly turnLifecycle: Pick<ChannelTurnExecutionLifecycle, 'end'>;
}

export interface ChannelTurnLifecycleOptions {
  readonly typing: ChannelTypingDelivery;
}

export interface InitializeChannelSystemOptions {
  readonly messages: ChannelFinalReplyMessageSource;
  readonly sessions: ChannelFinalReplySessionSource;
  readonly product: ChannelSystemProductCapabilities;
}

export interface ChannelSystemOwner {
  readonly terminalReplies: ChannelTerminalReplyObserver;
  readonly turnLifecycle: ChannelTurnExecutionLifecycle;
}
