import type {
  AfterLlmCallHandler,
  AgentExtension,
  StepEndHandler,
  TurnAssemblyCtx,
} from '@mavis/agent-runtime';

export interface TerminalRecoveryObservation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly attempts: number;
}

export interface TerminalResponseRecoveryExtensionOptions {
  readonly retryPrompt?: string;
  readonly onRecovered?: (observation: TerminalRecoveryObservation) => void | Promise<void>;
  readonly onFailed?: (observation: TerminalRecoveryObservation) => void | Promise<void>;
  readonly id?: string;
  readonly description?: string;
}

interface RecoveryState {
  lastToolBatch: 'none' | 'success' | 'error';
  attempts: number;
  recoveryPending: boolean;
}

const DEFAULT_RETRY_PROMPT =
  'The tools completed, but your response was empty. Provide a concise final response summarizing the result for the user.';

/**
 * Gives a post-tool empty assistant response one bounded recovery request.
 * A second empty response fails the product turn with `terminal_empty` rather
 * than reporting a blank success.
 */
export function terminalResponseRecoveryExtension(
  options: TerminalResponseRecoveryExtensionOptions = {},
): AgentExtension {
  const states = new Map<string, RecoveryState>();

  const onStepEnd: StepEndHandler = (event, ctx) => {
    const state = stateFor(states, ctx);
    state.lastToolBatch =
      event.toolResults.length === 0
        ? 'none'
        : event.toolResults.some((result) => result.isError)
          ? 'error'
          : 'success';
  };

  const afterLlmCall: AfterLlmCallHandler = async (event, ctx) => {
    const state = stateFor(states, ctx);
    if (event.message.stopReason === 'error' || event.message.stopReason === 'aborted') {
      return { type: 'continue' };
    }

    const hasToolIntent = event.message.content.some((block) => block.type === 'toolCall');
    const hasVisibleText = event.message.content.some(
      (block) => block.type === 'text' && block.text.trim().length > 0,
    );
    if (hasToolIntent || hasVisibleText) {
      if (state.recoveryPending && hasVisibleText) {
        await notify(options.onRecovered, observation(ctx, state.attempts));
        state.recoveryPending = false;
      }
      return { type: 'continue' };
    }

    if (state.recoveryPending) {
      state.attempts += 1;
      await notify(options.onFailed, observation(ctx, state.attempts));
      return { type: 'fail', reason: 'terminal_empty' };
    }

    if (state.lastToolBatch !== 'success') return { type: 'continue' };

    state.attempts = 1;
    state.recoveryPending = true;
    return {
      type: 'retry',
      reason: 'terminal_empty',
      prompt: options.retryPrompt ?? DEFAULT_RETRY_PROMPT,
    };
  };

  return {
    id: options.id ?? 'terminal-response-recovery',
    description:
      options.description ??
      'Retry one empty post-tool terminal response, then fail visibly with terminal_empty.',
    init(pi) {
      pi.on('on_step_end', onStepEnd);
      pi.on('after_llm_call', afterLlmCall);
      pi.on('turn_end', (_event, ctx) => {
        states.delete(runKey(ctx));
      });
    },
  };
}

function runKey(ctx: Pick<TurnAssemblyCtx, 'sessionId' | 'turnId'>): string {
  return `${ctx.sessionId}\u0000${ctx.turnId}`;
}

function stateFor(states: Map<string, RecoveryState>, ctx: TurnAssemblyCtx): RecoveryState {
  const key = runKey(ctx);
  let state = states.get(key);
  if (!state) {
    state = { lastToolBatch: 'none', attempts: 0, recoveryPending: false };
    states.set(key, state);
  }
  return state;
}

function observation(ctx: TurnAssemblyCtx, attempts: number): TerminalRecoveryObservation {
  return { sessionId: ctx.sessionId, turnId: ctx.turnId, attempts };
}

async function notify(
  observer:
    | TerminalResponseRecoveryExtensionOptions['onRecovered']
    | TerminalResponseRecoveryExtensionOptions['onFailed'],
  value: TerminalRecoveryObservation,
): Promise<void> {
  if (!observer) return;
  try {
    await observer(value);
  } catch {
    // Observability must not change recovery semantics.
  }
}
