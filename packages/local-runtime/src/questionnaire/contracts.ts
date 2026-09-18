import type { RuntimeConversation } from '@mavis/conversation-contract';
import type { ThreadGoalStatus } from '@mavis/goal';
import type {
  AskQuestionnaireMode,
  AskQuestionnaireModePayload,
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
  AskUserToolInput,
  AskUserToolMode,
} from '@mavis/shared/questionnaire';

import type { LocalRuntimeConfig } from '../config/types.js';
import type { GlobalEventPublisher } from '../events/global-events.js';
import type { LocalMessageChannelContext } from '../messages/input.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import type { QuestionnaireRequestRecord, QuestionnaireRequestStore } from './store.js';

export const GOAL_QUESTIONNAIRE_AUTO_REPLY_MS = 5 * 60 * 1000;

export interface QuestionnaireAutoReplySchedulerPort {
  schedule(record: QuestionnaireRequestRecord): void;
  scheduleRetry(requestId: string, sessionId: string): void;
  cancel(requestId: string): void;
}

export interface QuestionnaireGoal {
  goalId: string;
  status: ThreadGoalStatus;
}

export type QuestionnaireOwnedAction =
  | { readonly kind: 'reply'; readonly reply: AskQuestionnaireReplyPayload }
  | { readonly kind: 'dismiss' };

export type QuestionnaireOwnedActionDecision =
  | { readonly kind: 'handled' }
  | { readonly kind: 'continue-generic'; readonly continuationIdentity?: string };

export interface QuestionnaireOwnedActionInput {
  readonly record: QuestionnaireRequestRecord;
  readonly action: QuestionnaireOwnedAction;
  readonly dispatch: boolean;
}

export interface QuestionnaireOwnedActionHandler {
  handles(record: QuestionnaireRequestRecord): boolean;
  route(input: QuestionnaireOwnedActionInput): Promise<QuestionnaireOwnedActionDecision>;
  afterConsumed?(input: QuestionnaireOwnedActionInput): Promise<void>;
}

export interface QuestionnaireRequestAdmissionInput {
  readonly request: Readonly<AskQuestionnaireRequest>;
  readonly session: LocalSessionRecord;
}

export interface QuestionnaireRequestAdmissionRejection {
  readonly message: string;
  readonly status?: number;
  readonly code?: string;
}

/**
 * Optional owner policy evaluated after normalization and before any request is
 * persisted or delivered. `undefined` admits the request; a rejection is
 * mapped to the Questionnaire's stable local error contract.
 */
export type QuestionnaireRequestAdmission = (
  input: QuestionnaireRequestAdmissionInput,
) =>
  | QuestionnaireRequestAdmissionRejection
  | undefined
  | Promise<QuestionnaireRequestAdmissionRejection | undefined>;

export interface LocalQuestionnaireServiceDeps {
  store: QuestionnaireRequestStore;
  nowMs: () => number;
  primaryAgentName: string;
  configGetter: () => LocalRuntimeConfig;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  conversation?: Pick<RuntimeConversation, 'ingress'>;
  emitBusEvent: (type: string, payload: Record<string, unknown>) => void;
  publishGlobalEvent?: GlobalEventPublisher;
  onQuestionnaireAsk?: (record: QuestionnaireRequestRecord) => void | Promise<void>;
  requestAdmission?: QuestionnaireRequestAdmission;
  /** Runtime UI locale used for generated questionnaire text. */
  resolveLocale?: () => string;
  /**
   * Turn-terminal hook (same wrapper `notifySessionTurnFinished` used by
   * send-stream). Called after a dismiss so the pending API/channel/cron
   * queue drains — without this hook a `dismiss()` leaves the session stuck in
   * the ask_user idle state. A reply owns a direct resume Turn whose terminal
   * release performs the wake; dismiss does not inject a Turn by design
   * ("close is silent"), so it must kick the drain fan-out itself. Optional so
   * pure-headless callers can leave it undefined.
   */
  notifySessionTurnFinished?: (sessionId: string, status: 'finished') => void;
  ownedActionHandler?: QuestionnaireOwnedActionHandler;
  onOwnedActionFailure?: (requestId: string) => void;
  resolveGoal?: (sessionId: string) => Promise<QuestionnaireGoal | undefined>;
  canStartAutoReply?: (sessionId: string) => boolean;
  tryAcquireReplyInjection?: (requestId: string) => (() => void) | undefined;
  autoReplyScheduler?: QuestionnaireAutoReplySchedulerPort;
  /**
   * Decision v3 ask_user suppression probe: true while the session's active
   * Turn holds unconsumed user-producer steering. The ask_user tool adapter
   * consults it before creating a request; probe failures are treated as
   * false (fail-open — a broken probe must never swallow questions).
   */
  hasPendingUserSteering?: (sessionId: string) => Promise<boolean> | boolean;
}

export interface BeginQuestionnaireInput {
  toolInput: AskUserToolInput;
  agentName?: string;
  sessionId: string;
  messageId?: string;
  callId?: string;
  runId?: string;
  originChannelContext?: LocalMessageChannelContext;
}

export type OwnedQuestionnaireMode = Exclude<AskQuestionnaireMode, AskUserToolMode>;

export interface BeginOwnedQuestionnaireInput extends BeginQuestionnaireInput {
  mode: OwnedQuestionnaireMode;
  modePayload?: AskQuestionnaireModePayload;
}
export interface BeginQuestionnaireResult {
  requestId: string;
  schemaVersion: 2;
  stepCount: number;
  record: QuestionnaireRequestRecord;
}

export interface ReplyQuestionnaireInput {
  agentName: string;
  requestId: string;
  reply: AskQuestionnaireReplyPayload;
  /** Internal runtime source; DesktopService callers use the default user source. */
  source?: 'user' | 'auto';
}

export interface ReplyQuestionnaireResult {
  ok: true;
  requestId: string;
  sessionId: string;
  agentName?: string;
  answeredAt: number;
  injected: boolean;
}

export interface DismissQuestionnaireInput {
  agentName: string;
  requestId: string;
}

export interface DismissQuestionnaireResult {
  ok: true;
  requestId: string;
  sessionId: string;
  agentName?: string;
  dismissedAt: number;
}

export interface QuestionnaireRecoveryStats {
  expired: number;
  reinjected: number;
  reemitted: number;
}
