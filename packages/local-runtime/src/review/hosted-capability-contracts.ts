import type {
  InternalTurnPromptReadRegistry,
  PromptReadScope,
  PromptSnapshotSource,
} from '@mavis/agent-core';
import type { RuntimeConversation } from '@mavis/conversation-contract';

import type { LocalRuntimeLogger } from '../common/logger.js';
import type { MetricsClient } from '../common/metrics.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { RemoteTokenCounter } from '../context/remote-token-counter.js';
import type { ReviewActivityIdentity } from './activity-events.js';
import type { createReviewAfterLlmHook } from './after-llm-hook.js';
import type { ReviewTurnState } from './turn-state.js';

export interface HostedReviewTurnIdentity {
  readonly sessionId: string;
  readonly turnId: string;
}

export interface HostedReviewIntent {
  readonly kind: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface HostedReviewPromptInput extends HostedReviewTurnIdentity {
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly userInput: string;
  readonly intent?: HostedReviewIntent;
  readonly promptRead?: PromptReadScope;
}

export interface HostedReviewCapabilityOptions {
  readonly reviewPromptDir: string;
  readonly configGetter: () => LocalRuntimeConfig;
  readonly conversation?: RuntimeConversation;
  readonly metricsClient?: MetricsClient;
  readonly logger?: Pick<LocalRuntimeLogger, 'info' | 'warn' | 'error'>;
  readonly remoteCounter?: RemoteTokenCounter;
  readonly nowMs?: () => number;
  readonly promptSnapshots?: () => PromptSnapshotSource | undefined;
  readonly internalTurnPromptReads?: () => InternalTurnPromptReadRegistry | undefined;
}

export interface StoredReviewTurn {
  readonly state: ReviewTurnState;
  promptRead?: PromptReadScope;
  afterLlmHook?: ReturnType<typeof createReviewAfterLlmHook>;
  subagentRun?: Promise<HostedReviewSubagentResult>;
  activity?: ReviewActivityIdentity & { terminal?: boolean };
}

export type HostedReviewSubagentResult =
  | { readonly status: 'succeeded'; readonly finalText: string }
  | { readonly status: 'failed'; readonly errorMessage: string }
  | { readonly status: 'aborted' };
