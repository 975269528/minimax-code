import type {
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
  AskQuestionnaireStatus,
} from '@mavis/shared/questionnaire';
import type { LocalMessageChannelContext } from '../messages/input.js';

export interface QuestionnaireRequestRecord {
  requestId: string;
  sessionId: string;
  agentName?: string;
  msgId?: string;
  originChannelContext?: LocalMessageChannelContext;
  request: AskQuestionnaireRequest;
  status: AskQuestionnaireStatus;
  createdAt: number;
  answeredAt?: number;
  replyPayload?: AskQuestionnaireReplyPayload;
  injectedAt?: number;
  dismissedAt?: number;
}

export type BeginPendingWithPolicyResult =
  | {
      readonly status: 'created';
      readonly supersededRequestIds: readonly string[];
    }
  | { readonly status: 'pending-conflict' };

export interface ReplacePendingForActiveGoalResult {
  inserted: boolean;
  supersededRequestIds: string[];
}

export interface QuestionnaireRequestStore {
  beginPendingWithPolicy(input: {
    record: QuestionnaireRequestRecord;
    policy: 'replaceable' | 'exclusive';
    createdAtCutoff: number;
  }): Promise<BeginPendingWithPolicyResult>;
  upsert(record: QuestionnaireRequestRecord): Promise<void>;
  /**
   * Atomically verify Goal ownership, persist the new pending request, and
   * supersede older pending requests for the session. A failed ownership
   * check must not mutate questionnaire state.
   */
  replacePendingForActiveGoal(
    record: QuestionnaireRequestRecord,
    goalId: string,
  ): Promise<ReplacePendingForActiveGoalResult>;
  get(requestId: string): Promise<QuestionnaireRequestRecord | null>;
  delete(requestId: string): Promise<boolean>;
  getAll(): Promise<QuestionnaireRequestRecord[]>;
  deleteBySession(sessionId: string): Promise<number>;
  markAnswered(
    requestId: string,
    answeredAt: number,
    replyPayload?: AskQuestionnaireReplyPayload,
  ): Promise<boolean>;
  settleReply(
    requestId: string,
    answeredAt: number,
    replyPayload: AskQuestionnaireReplyPayload,
    options: { readonly requirePending: boolean },
  ): Promise<boolean>;
  markInjected(requestId: string, injectedAt: number): Promise<boolean>;
  markDismissed(requestId: string, dismissedAt: number): Promise<boolean>;
  expirePendingRequest(requestId: string, cutoff: number): Promise<boolean>;
  /**
   * Atomically settle a Goal questionnaire only while it is the session's
   * canonical pending request and the owning Goal is still active.
   */
  markAnsweredForActiveGoal(
    requestId: string,
    sessionId: string,
    goalId: string,
    answeredAt: number,
    replyPayload?: AskQuestionnaireReplyPayload,
  ): Promise<boolean>;
  markSuperseded(requestId: string): Promise<boolean>;
  supersedePendingBySession(sessionId: string, keepRequestId: string): Promise<string[]>;
  /** Expire stale non-Goal waits; Goal-owned waits keep their Goal lifecycle semantics. */
  expirePendingOlderThan(cutoff: number): Promise<number>;
  findAllPendingForRecovery(): Promise<QuestionnaireRequestRecord[]>;
  findAnsweredPendingInject(): Promise<QuestionnaireRequestRecord[]>;
  findOwnedActionsPendingCompletion(): Promise<QuestionnaireRequestRecord[]>;
  findLatestPendingBySession(
    sessionId: string,
    createdAtCutoff?: number,
  ): Promise<QuestionnaireRequestRecord | null>;
  findLatestPlanReviewBySession(
    sessionId: string,
    createdAtCutoff?: number,
  ): Promise<QuestionnaireRequestRecord | null>;
  findUnresolvedForRewind(sessionId: string): Promise<QuestionnaireRequestRecord[]>;
  deleteUnresolvedForRewind(input: {
    sessionId: string;
    requestIds: readonly string[];
  }): Promise<QuestionnaireRequestRecord[]>;
  /** Pending UI request or answered reply whose direct admission is not acknowledged yet. */
  hasUnresolvedBySession(sessionId: string): Promise<boolean>;
  /** Latest request regardless of terminal state; used by turn-admission identity guards. */
  findLatestBySession(sessionId: string): Promise<QuestionnaireRequestRecord | null>;
}
