import type { TuiPendingPermission } from '../../types/runtime-models.js';
import type { ActiveTuiQuestionnaire } from '../interaction/questionnaire.js';
import type {
  TuiBackgroundTaskState,
  TuiQueueItemState,
  TuiRunState,
  TuiSubagentState,
} from './model.js';

export type TuiAction =
  | { type: 'session/activate'; sessionId?: string }
  | {
      type: 'interaction/permissionReceived';
      sessionId: string;
      permission: TuiPendingPermission;
    }
  | {
      type: 'interaction/permissionResolved';
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'interaction/questionnaireReceived';
      sessionId: string;
      questionnaire: ActiveTuiQuestionnaire;
    }
  | {
      type: 'interaction/questionnaireResolved';
      sessionId: string;
      requestId: string;
    }
  | {
      type: 'interaction/snapshotReplaced';
      sessionId: string;
      permission?: TuiPendingPermission;
      questionnaire?: ActiveTuiQuestionnaire;
      expectedPermissionRevision?: number;
      expectedQuestionnaireRevision?: number;
    }
  | {
      type: 'interaction/snapshotReconciled';
      sessionId: string;
      permission?: TuiPendingPermission | null;
      questionnaire?: ActiveTuiQuestionnaire | null;
      expectedPermissionRevision?: number;
      expectedQuestionnaireRevision?: number;
    }
  | { type: 'execution/runObserved'; sessionId: string; run: TuiRunState }
  | {
      type: 'execution/runsReconciled';
      sessionId: string;
      runs: readonly TuiRunState[];
      expectedRunRevision: number;
    }
  | { type: 'execution/queueObserved'; sessionId: string; item: TuiQueueItemState }
  | {
      type: 'execution/queueReplaced';
      sessionId: string;
      items: readonly TuiQueueItemState[];
      expectedQueueRevision?: number;
    }
  | { type: 'execution/taskObserved'; sessionId: string; task: TuiBackgroundTaskState }
  | { type: 'execution/subagentObserved'; sessionId: string; subagent: TuiSubagentState }
  | { type: 'connection/disconnected'; error?: string }
  | { type: 'connection/subscribed' }
  | { type: 'connection/reconnected' }
  | { type: 'connection/sessionReconciled'; sessionId: string }
  | { type: 'lifecycle/leaveUi' }
  | { type: 'lifecycle/stopped' };

export interface TuiReconcileSessionEffect {
  readonly type: 'runtime/reconcileSession';
  readonly sessionId: string;
}

export type TuiEffect = TuiReconcileSessionEffect;
