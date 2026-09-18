import type { TuiAction, TuiEffect } from './actions.js';
import {
  createTuiSessionView,
  type TuiBackgroundTaskState,
  type TuiQueueItemState,
  type TuiRunState,
  type TuiSessionViewState,
  type TuiState,
  type TuiSubagentState,
} from './model.js';

const MAX_CLOSED_QUESTIONNAIRE_IDS = 128;

export interface TuiTransition {
  readonly state: TuiState;
  readonly effects: readonly TuiEffect[];
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiTransition {
  if (action.type === 'session/activate') {
    if (!action.sessionId) {
      return { state: { ...state, activeSessionId: undefined }, effects: [] };
    }
    return updateSession(state, action.sessionId, (session) => session, {
      activeSessionId: action.sessionId,
    });
  }

  if (action.type === 'interaction/permissionReceived') {
    return updateSession(state, action.sessionId, (session) => ({
      ...session,
      interactions: { ...session.interactions, permission: action.permission },
      permissionRevision: session.permissionRevision + 1,
      attention: { ...session.attention, permission: true },
    }));
  }
  if (action.type === 'interaction/permissionResolved') {
    return updateSession(state, action.sessionId, (session) => {
      if (session.interactions.permission?.requestId !== action.requestId) return session;
      return {
        ...session,
        interactions: { ...session.interactions, permission: undefined },
        permissionRevision: session.permissionRevision + 1,
        attention: { ...session.attention, permission: false },
      };
    });
  }
  if (action.type === 'interaction/questionnaireReceived') {
    return updateSession(state, action.sessionId, (session) => {
      const requestId = action.questionnaire.request.id;
      if (session.closedQuestionnaireIds.has(requestId)) return session;
      const current = session.interactions.questionnaire;
      const questionnaire =
        current?.request.id === requestId
          ? { ...action.questionnaire, answers: current.answers }
          : action.questionnaire;
      return {
        ...session,
        interactions: {
          ...session.interactions,
          questionnaire,
        },
        questionnaireRevision: session.questionnaireRevision + 1,
        attention: { ...session.attention, question: true },
      };
    });
  }
  if (action.type === 'interaction/questionnaireResolved') {
    return updateSession(state, action.sessionId, (session) => {
      const closedQuestionnaireIds = rememberClosedQuestionnaire(
        session.closedQuestionnaireIds,
        action.requestId,
      );
      if (session.interactions.questionnaire?.request.id !== action.requestId) {
        return {
          ...session,
          closedQuestionnaireIds,
          questionnaireRevision: session.questionnaireRevision + 1,
        };
      }
      return {
        ...session,
        interactions: { ...session.interactions, questionnaire: undefined },
        questionnaireRevision: session.questionnaireRevision + 1,
        closedQuestionnaireIds,
        attention: { ...session.attention, question: false },
      };
    });
  }
  if (action.type === 'interaction/snapshotReplaced') {
    return updateSession(state, action.sessionId, (session) => {
      const canApplyQuestionnaire = isCurrentQuestionnaireSnapshot(session, action);
      const canApplyPermission = isCurrentPermissionSnapshot(session, action);
      const questionnaire = canApplyQuestionnaire
        ? resolveSnapshotQuestionnaire(session, action.questionnaire)
        : session.interactions.questionnaire;
      return {
        ...session,
        interactions: {
          permission: canApplyPermission ? action.permission : session.interactions.permission,
          questionnaire,
        },
        ...(canApplyPermission ? { permissionRevision: session.permissionRevision + 1 } : {}),
        ...(canApplyQuestionnaire
          ? { questionnaireRevision: session.questionnaireRevision + 1 }
          : {}),
        attention: {
          ...session.attention,
          permission: Boolean(
            canApplyPermission ? action.permission : session.interactions.permission,
          ),
          question: Boolean(questionnaire),
        },
      };
    });
  }
  if (action.type === 'interaction/snapshotReconciled') {
    return updateSession(state, action.sessionId, (session) => {
      const interactions = { ...session.interactions };
      const attention = { ...session.attention };
      let permissionRevision = session.permissionRevision;
      let questionnaireRevision = session.questionnaireRevision;
      if ('permission' in action && isCurrentPermissionSnapshot(session, action)) {
        interactions.permission = action.permission ?? undefined;
        attention.permission = Boolean(action.permission);
        permissionRevision += 1;
      }
      if ('questionnaire' in action && isCurrentQuestionnaireSnapshot(session, action)) {
        interactions.questionnaire = resolveSnapshotQuestionnaire(
          session,
          action.questionnaire ?? undefined,
        );
        attention.question = Boolean(interactions.questionnaire);
        questionnaireRevision += 1;
      }
      return {
        ...session,
        interactions,
        attention,
        permissionRevision,
        questionnaireRevision,
      };
    });
  }
  if (action.type === 'execution/runObserved') {
    return updateSession(state, action.sessionId, (session) => {
      const runs =
        action.run.status === 'terminal'
          ? new Map(session.execution.runs)
          : new Map([[action.run.runId, action.run]]);
      if (action.run.status === 'terminal') runs.delete(action.run.runId);
      return {
        ...session,
        runRevision: session.runRevision + 1,
        execution: { ...session.execution, runs },
      };
    });
  }
  if (action.type === 'execution/runsReconciled') {
    return updateSession(state, action.sessionId, (session) => {
      if (session.runRevision !== action.expectedRunRevision) return session;
      return {
        ...session,
        runRevision: session.runRevision + 1,
        execution: {
          ...session.execution,
          runs: new Map(action.runs.map((run) => [run.runId, run])),
        },
      };
    });
  }
  if (action.type === 'execution/queueObserved') {
    return updateSession(state, action.sessionId, (session) => {
      const queue = new Map(session.execution.queue);
      if (action.item.status === 'queued') {
        const current = queue.get(action.item.itemId);
        queue.set(action.item.itemId, { ...current, ...action.item });
      } else {
        queue.delete(action.item.itemId);
      }
      return {
        ...session,
        queueRevision: session.queueRevision + 1,
        execution: { ...session.execution, queue },
      };
    });
  }
  if (action.type === 'execution/queueReplaced') {
    return updateSession(state, action.sessionId, (session) => {
      if (
        action.expectedQueueRevision !== undefined &&
        action.expectedQueueRevision !== session.queueRevision
      ) {
        return session;
      }
      const items = action.items.filter((item) => item.status === 'queued');
      return {
        ...session,
        queueRevision: session.queueRevision + 1,
        execution: {
          ...session.execution,
          queue: new Map(items.map((item) => [item.itemId, item])),
        },
      };
    });
  }
  if (action.type === 'execution/taskObserved') {
    return updateExecutionMap(state, action.sessionId, 'tasks', action.task.taskId, action.task);
  }
  if (action.type === 'execution/subagentObserved') {
    return updateExecutionMap(
      state,
      action.sessionId,
      'subagents',
      action.subagent.subagentId,
      action.subagent,
    );
  }
  if (action.type === 'connection/disconnected') {
    return {
      state: {
        ...state,
        connection: {
          ...state.connection,
          phase: 'disconnected',
          ...(action.error ? { lastError: action.error } : {}),
        },
      },
      effects: [],
    };
  }
  if (action.type === 'connection/subscribed') {
    return {
      state: {
        ...state,
        connection: { ...state.connection, phase: 'subscribed' },
      },
      effects: [],
    };
  }
  if (action.type === 'connection/reconnected') {
    const sessionIds = [...state.sessions.keys()];
    return {
      state: {
        ...state,
        connection: {
          phase: sessionIds.length > 0 ? 'reconciling' : 'live',
          generation: state.connection.generation + 1,
          pendingSessions: new Set(sessionIds),
          lastError: undefined,
        },
      },
      effects: sessionIds.map((sessionId) => ({
        type: 'runtime/reconcileSession',
        sessionId,
      })),
    };
  }
  if (action.type === 'connection/sessionReconciled') {
    const pendingSessions = new Set(state.connection.pendingSessions);
    pendingSessions.delete(action.sessionId);
    return {
      state: {
        ...state,
        connection: {
          ...state.connection,
          phase: pendingSessions.size === 0 ? 'live' : 'reconciling',
          pendingSessions,
        },
      },
      effects: [],
    };
  }
  if (action.type === 'lifecycle/leaveUi') {
    return {
      state: { ...state, lifecycle: { phase: 'leaving-ui' } },
      effects: [],
    };
  }
  return {
    state: { ...state, lifecycle: { phase: 'stopped' } },
    effects: [],
  };
}

function isCurrentQuestionnaireSnapshot(
  session: TuiSessionViewState,
  action: {
    readonly expectedQuestionnaireRevision?: number;
  },
): boolean {
  return (
    action.expectedQuestionnaireRevision === undefined ||
    action.expectedQuestionnaireRevision === session.questionnaireRevision
  );
}

function isCurrentPermissionSnapshot(
  session: TuiSessionViewState,
  action: {
    readonly expectedPermissionRevision?: number;
  },
): boolean {
  return (
    action.expectedPermissionRevision === undefined ||
    action.expectedPermissionRevision === session.permissionRevision
  );
}

function resolveSnapshotQuestionnaire(
  session: TuiSessionViewState,
  questionnaire: TuiSessionViewState['interactions']['questionnaire'],
): TuiSessionViewState['interactions']['questionnaire'] {
  if (!questionnaire) return undefined;
  if (session.closedQuestionnaireIds.has(questionnaire.request.id)) {
    return session.interactions.questionnaire;
  }
  const current = session.interactions.questionnaire;
  return current?.request.id === questionnaire.request.id
    ? { ...questionnaire, answers: current.answers }
    : questionnaire;
}

function rememberClosedQuestionnaire(
  current: ReadonlySet<string>,
  requestId: string,
): ReadonlySet<string> {
  const next = new Set(current);
  next.delete(requestId);
  next.add(requestId);
  while (next.size > MAX_CLOSED_QUESTIONNAIRE_IDS) {
    const oldest = next.values().next().value as string | undefined;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

function updateSession(
  state: TuiState,
  sessionId: string,
  update: (session: TuiSessionViewState) => TuiSessionViewState,
  stateUpdate: Partial<TuiState> = {},
): TuiTransition {
  const current = state.sessions.get(sessionId) ?? createTuiSessionView(sessionId);
  const sessions = new Map(state.sessions);
  sessions.set(sessionId, update(current));
  return {
    state: { ...state, ...stateUpdate, sessions },
    effects: [],
  };
}

function updateExecutionMap(
  state: TuiState,
  sessionId: string,
  key: keyof TuiSessionViewState['execution'],
  id: string,
  value: TuiRunState | TuiQueueItemState | TuiBackgroundTaskState | TuiSubagentState,
): TuiTransition {
  return updateSession(state, sessionId, (session) => {
    const map = new Map(session.execution[key] as ReadonlyMap<string, typeof value>);
    map.set(id, value);
    return {
      ...session,
      execution: { ...session.execution, [key]: map },
    } as TuiSessionViewState;
  });
}
