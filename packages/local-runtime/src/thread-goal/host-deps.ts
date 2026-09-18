import type { LocalMessageInput } from '../messages/input.js';
import type { DataDirInput } from '../persistence/db.js';
import type { LocalActiveTurnTimingReader } from '../turns/active-turn-timing.js';
import type { GlobalEventPublisher } from '../events/global-events.js';
import type { ThreadGoalState } from '@mavis/goal';
import type {
  InternalTurnPromptReadRegistry,
  PromptReadScope,
  PromptSnapshotSource,
} from '@mavis/agent-core';

import type { ThreadGoalRuntimeEventSink } from './events.js';
import type { ThreadGoalGateConfig } from './gate.js';

export interface InternalGoalPromptTurn {
  readonly requestedTurnId: string;
  readonly promptRead: PromptReadScope;
}

/** Host-owned ports required by the Thread Goal facade and its deep modules. */
export interface LocalThreadGoalIntegrationDeps {
  readonly dataDir: DataDirInput;
  readonly nowMs: () => number;
  readonly turnTimingReader: LocalActiveTurnTimingReader;
  readonly publishGlobalEvent: GlobalEventPublisher;
  readonly promptSnapshots?: () => PromptSnapshotSource | undefined;
  readonly internalTurnPromptReads?: () => InternalTurnPromptReadRegistry | undefined;
  readonly isSessionBusy?: (sessionId: string) => boolean;
  readonly hasPendingQuestionnaire: (
    sessionId: string,
    expectedGoalId?: string,
  ) => Promise<boolean> | boolean;
  readonly retireGoalQuestionnaire: (
    sessionId: string,
    goalId: string,
  ) => Promise<boolean> | boolean;
  readonly hasPendingPermission: (sessionId: string) => Promise<boolean> | boolean;
  readonly hasAutomationOwnerConflict: (sessionId: string) => Promise<boolean> | boolean;
  readonly hasRequiredBackgroundWork: (sessionId: string) => Promise<boolean> | boolean;
  readonly startContinuationTurn: (
    sessionId: string,
    message: LocalMessageInput,
    displayContent?: string,
    internalPromptRead?: InternalGoalPromptTurn,
  ) => Promise<'started' | 'already-active' | void>;
  readonly steerContinuationTurn?: (input: {
    readonly sessionId: string;
    readonly message: LocalMessageInput;
    readonly idempotencyKey: string;
    readonly internalPromptRead?: InternalGoalPromptTurn;
    readonly onAccepted: (accepted: {
      readonly mode: 'activated' | 'steered';
      readonly turnId: string;
    }) => void | Promise<void>;
  }) => Promise<{
    readonly mode: 'activated' | 'steered' | 'duplicate';
    readonly turnId: string;
  }>;
  readonly enqueuePostTurnContinuation?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: LocalMessageInput;
    readonly clientRequestId?: string;
    readonly internalPromptRead?: InternalGoalPromptTurn;
  }) => Promise<void>;
  /** Abort only the active Turn whose admitted source is Thread Goal. */
  readonly abortThreadGoalTurn?: (sessionId: string, turnId: string) => Promise<boolean>;
  readonly enqueueInitialContinuationTurn: (
    goal: ThreadGoalState,
    message: LocalMessageInput,
    clientRequestId: string,
    internalPromptRead?: InternalGoalPromptTurn,
  ) => Promise<void>;
  readonly hasPendingInitialContinuation: (
    sessionId: string,
    clientRequestId: string,
  ) => Promise<boolean> | boolean;
  readonly cancelInitialContinuation: (sessionId: string, clientRequestId: string) => Promise<void>;
  readonly requestQueueDispatch: (sessionId: string) => void;
  readonly reportFailure: (sessionId: string, message: string) => void;
  readonly formatError: (error: unknown) => string;
  readonly isEnabled?: () => boolean;
  readonly configGetter?: () => ThreadGoalGateConfig;
  readonly emitRuntimeEvent?: ThreadGoalRuntimeEventSink;
}
