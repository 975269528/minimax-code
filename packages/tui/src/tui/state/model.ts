import type { TuiPendingPermission, TuiQueuedMessage } from '../../types/runtime-models.js';
import type { ActiveTuiQuestionnaire } from '../interaction/questionnaire.js';

export type TuiConnectionPhase =
  | 'disconnected'
  | 'snapshotting'
  | 'subscribed'
  | 'reconciling'
  | 'live';

export interface TuiRunState {
  readonly runId: string;
  readonly status: 'starting' | 'running' | 'blocked' | 'terminal';
  readonly turnId?: string;
}

export interface TuiQueueItemState {
  readonly itemId: string;
  readonly status: string;
  readonly content?: string;
  readonly runtimeItem?: TuiQueuedMessage;
}

export interface TuiBackgroundTaskState {
  readonly taskId: string;
  readonly status: string;
  readonly title?: string;
}

export interface TuiSubagentState {
  readonly subagentId: string;
  readonly status: string;
  readonly name?: string;
}

export interface TuiSessionExecutionState {
  readonly runs: ReadonlyMap<string, TuiRunState>;
  readonly queue: ReadonlyMap<string, TuiQueueItemState>;
  readonly tasks: ReadonlyMap<string, TuiBackgroundTaskState>;
  readonly subagents: ReadonlyMap<string, TuiSubagentState>;
}

export interface TuiInteractionState {
  readonly permission?: TuiPendingPermission;
  readonly questionnaire?: ActiveTuiQuestionnaire;
}

export interface TuiSessionViewState {
  readonly sessionId: string;
  readonly execution: TuiSessionExecutionState;
  readonly interactions: TuiInteractionState;
  readonly runRevision: number;
  readonly queueRevision: number;
  readonly permissionRevision: number;
  readonly questionnaireRevision: number;
  readonly closedQuestionnaireIds: ReadonlySet<string>;
  readonly attention: {
    readonly permission: boolean;
    readonly question: boolean;
    readonly unread: number;
  };
}

export interface TuiState {
  readonly activeSessionId?: string;
  readonly sessions: ReadonlyMap<string, TuiSessionViewState>;
  readonly connection: {
    readonly phase: TuiConnectionPhase;
    readonly generation: number;
    readonly pendingSessions: ReadonlySet<string>;
    readonly lastError?: string;
  };
  readonly lifecycle: {
    readonly phase: 'running' | 'leaving-ui' | 'stopped';
  };
}

export function createTuiState(): TuiState {
  return {
    sessions: new Map(),
    connection: {
      phase: 'snapshotting',
      generation: 0,
      pendingSessions: new Set(),
    },
    lifecycle: { phase: 'running' },
  };
}

export function createTuiSessionView(sessionId: string): TuiSessionViewState {
  return {
    sessionId,
    execution: {
      runs: new Map(),
      queue: new Map(),
      tasks: new Map(),
      subagents: new Map(),
    },
    interactions: {},
    runRevision: 0,
    queueRevision: 0,
    permissionRevision: 0,
    questionnaireRevision: 0,
    closedQuestionnaireIds: new Set(),
    attention: {
      permission: false,
      question: false,
      unread: 0,
    },
  };
}
