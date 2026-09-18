import type { TuiRuntimeEvent } from '../types/runtime-events.js';

export type TuiAcpTurnTransition =
  | { readonly kind: 'continue'; readonly turnId: string }
  | { readonly kind: 'end' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message?: string };

/**
 * Correlates a questionnaire-blocked Run with the Runtime continuation turn
 * started after the client answers it. Runtime lifecycle events may arrive
 * before the original Run result, so all observations are buffered.
 */
export class TuiAcpPromptContinuation {
  private observedTurnId: string;
  private readonly questionTurns = new Set<string>();
  private readonly questionTurnByRequestId = new Map<string, string>();
  private readonly questionnaireOutcomes = new Map<string, boolean>();
  private readonly nextTurnIds: string[] = [];
  private readonly terminalEvents = new Map<string, TuiRuntimeEvent>();
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly sessionId: string,
    initialTurnId: string,
  ) {
    this.observedTurnId = initialTurnId;
  }

  observe(event: TuiRuntimeEvent): void {
    const eventSessionId =
      event.type === 'questionnaire.ask'
        ? (event.request.requester?.sessionId ?? event.sessionId)
        : event.sessionId;
    if (eventSessionId !== this.sessionId) return;

    if (event.type === 'questionnaire.ask') {
      this.questionTurns.add(this.observedTurnId);
      this.questionTurnByRequestId.set(event.request.id, this.observedTurnId);
      this.wake();
      return;
    }
    if (event.type === 'questionnaire.dismiss' || event.type === 'questionnaire.superseded') {
      this.settleQuestionnaire(event.requestId, false);
      return;
    }
    if (event.type === 'session.start') {
      if (!event.turnId) return;
      if (event.turnId !== this.observedTurnId && !this.nextTurnIds.includes(event.turnId)) {
        this.nextTurnIds.push(event.turnId);
      }
      this.observedTurnId = event.turnId;
      this.wake();
      return;
    }
    if (
      event.type === 'session.finish' ||
      event.type === 'session.error' ||
      event.type === 'session.abort'
    ) {
      if (!event.turnId) return;
      this.terminalEvents.set(event.turnId, event);
      this.wake();
    }
  }

  settleQuestionnaire(requestId: string, continued: boolean): void {
    const turnId = this.questionTurnByRequestId.get(requestId);
    if (!turnId) return;
    this.questionnaireOutcomes.set(turnId, continued);
    this.wake();
  }

  async waitForTransition(
    turnId: string,
    signal: AbortSignal,
    options: { readonly requireQuestion?: boolean } = {},
  ): Promise<TuiAcpTurnTransition> {
    while (!signal.aborted) {
      const transition = this.resolveTransition(turnId, options.requireQuestion === true);
      if (transition) return transition;
      await this.waitForChange(signal);
    }
    throw signal.reason ?? new Error('ACP prompt cancelled.');
  }

  private resolveTransition(
    turnId: string,
    requireQuestion: boolean,
  ): TuiAcpTurnTransition | undefined {
    if (this.questionTurns.has(turnId)) {
      const continued = this.questionnaireOutcomes.get(turnId);
      if (continued === false) return { kind: 'end' };
      if (continued === true) {
        const nextIndex = this.nextTurnIds.findIndex((candidate) => candidate !== turnId);
        if (nextIndex >= 0) {
          const [nextTurnId] = this.nextTurnIds.splice(nextIndex, 1);
          if (nextTurnId) return { kind: 'continue', turnId: nextTurnId };
        }
      }
      const terminal = this.terminalEvents.get(turnId);
      if (terminal?.type === 'session.abort') return { kind: 'cancelled' };
      if (terminal?.type === 'session.error') {
        return { kind: 'failed', ...(terminal.error ? { message: terminal.error } : {}) };
      }
      return undefined;
    }
    if (requireQuestion) return undefined;

    const terminal = this.terminalEvents.get(turnId);
    if (!terminal) return undefined;
    if (terminal.type === 'session.finish') return { kind: 'end' };
    if (terminal.type === 'session.abort') return { kind: 'cancelled' };
    if (terminal.type === 'session.error') {
      return { kind: 'failed', ...(terminal.error ? { message: terminal.error } : {}) };
    }
    return undefined;
  }

  private waitForChange(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort);
        this.waiters.delete(finish);
        resolve();
      };
      const abort = () => {
        signal.removeEventListener('abort', abort);
        this.waiters.delete(finish);
        reject(signal.reason ?? new Error('ACP prompt cancelled.'));
      };
      this.waiters.add(finish);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}
