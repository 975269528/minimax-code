export type TodoStatus = string;

export interface TodoStateSummary {
  total: number;
  active: number;
  completed: number;
  cancelled: number;
  lastUpdatedTurn?: number | undefined;
}

interface TodoStateRecord extends TodoStateSummary {
  lastReminderTurn?: number | undefined;
}

const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);
const todoStates = new Map<string, TodoStateRecord>();

export function summarizeTodoStatuses(todos: Array<{ status: TodoStatus }>): TodoStateSummary {
  let completed = 0;
  let cancelled = 0;
  let active = 0;

  for (const todo of todos) {
    if (todo.status === 'completed') completed += 1;
    else if (todo.status === 'cancelled') cancelled += 1;
    else active += 1;
  }

  return { total: todos.length, active, completed, cancelled };
}

export function updateTodoState(
  sessionId: string,
  todos: Array<{ status: TodoStatus }>,
  turnCount?: number,
): TodoStateSummary {
  const summary = summarizeTodoStatuses(todos);

  if (summary.total === 0 || summary.active === 0) {
    todoStates.delete(sessionId);
    return { ...summary, ...(turnCount !== undefined ? { lastUpdatedTurn: turnCount } : {}) };
  }

  const existing = todoStates.get(sessionId);
  const record: TodoStateRecord = {
    ...summary,
    ...(turnCount !== undefined ? { lastUpdatedTurn: turnCount } : {}),
    ...(existing?.lastReminderTurn !== undefined
      ? { lastReminderTurn: existing.lastReminderTurn }
      : {}),
  };
  todoStates.set(sessionId, record);
  return record;
}

export function touchTodoStateTurn(sessionId: string, turnCount: number): void {
  const state = todoStates.get(sessionId);
  if (state) state.lastUpdatedTurn = turnCount;
}

export function getTodoState(sessionId: string): TodoStateSummary | undefined {
  const state = todoStates.get(sessionId);
  if (!state) return undefined;
  const { lastReminderTurn: _lastReminderTurn, ...summary } = state;
  return summary;
}

export function shouldInjectTodoCompletionReminder(
  sessionId: string,
  turnCount: number,
  interval = 5,
): TodoStateSummary | undefined {
  const state = todoStates.get(sessionId);
  if (!state || state.active <= 0) return undefined;

  if (state.lastReminderTurn !== undefined && turnCount - state.lastReminderTurn < interval) {
    return undefined;
  }

  state.lastReminderTurn = turnCount;
  const { lastReminderTurn: _lastReminderTurn, ...summary } = state;
  return summary;
}

export function clearTodoState(sessionId: string): void {
  todoStates.delete(sessionId);
}

export function _resetTodoStateForTests(): void {
  todoStates.clear();
}

export function isTodoTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
