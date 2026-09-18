import type { TuiAction, TuiEffect } from './actions.js';
import type { TuiState } from './model.js';
import { reduceTuiState } from './reducer.js';

export type TuiStateListener = (state: TuiState, action: TuiAction) => void;

export class TuiStateStore {
  private state: TuiState;
  private readonly listeners = new Set<TuiStateListener>();

  constructor(initialState: TuiState) {
    this.state = initialState;
  }

  snapshot(): TuiState {
    return this.state;
  }

  dispatch(action: TuiAction): readonly TuiEffect[] {
    const transition = reduceTuiState(this.state, action);
    this.state = transition.state;
    for (const listener of this.listeners) listener(this.state, action);
    return transition.effects;
  }

  subscribe(listener: TuiStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export type TuiEffectHandler = (
  effect: TuiEffect,
) => Promise<TuiAction | readonly TuiAction[] | undefined>;

export class TuiEffectRunner {
  constructor(
    private readonly handler: TuiEffectHandler,
    private readonly dispatch: (action: TuiAction) => readonly TuiEffect[],
  ) {}

  async run(effects: readonly TuiEffect[]): Promise<void> {
    const pending = [...effects];
    while (pending.length > 0) {
      const effect = pending.shift();
      if (!effect) continue;
      const result = await this.handler(effect);
      const actions = result ? (Array.isArray(result) ? result : [result]) : [];
      for (const action of actions) pending.push(...this.dispatch(action));
    }
  }
}
