import type { TuiSessionViewState, TuiState } from './model.js';

export function selectSessionView(
  state: TuiState,
  sessionId: string,
): TuiSessionViewState | undefined {
  return state.sessions.get(sessionId);
}

export function selectActiveSessionView(state: TuiState): TuiSessionViewState | undefined {
  return state.activeSessionId ? selectSessionView(state, state.activeSessionId) : undefined;
}
