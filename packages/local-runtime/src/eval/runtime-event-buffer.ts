import { logger } from '../common/logger.js';
import type { LocalEvalRuntimeEventInput } from './types.js';

const MAX_BUFFERED_RUNTIME_EVENTS_PER_SESSION = 128;
const RUNTIME_EVENT_BUFFER_TTL_MS = 30 * 60 * 1_000;

interface BufferedRuntimeEvent {
  readonly bufferedAt: number;
  readonly input: LocalEvalRuntimeEventInput;
}

/** Owns the bounded pre-Turn queue for runtime observations. */
export class LocalEvalRuntimeEventBuffer {
  private readonly bufferedBySession = new Map<string, BufferedRuntimeEvent[]>();

  constructor(private readonly nowMs: () => number) {}

  report(
    sessionId: string,
    input: LocalEvalRuntimeEventInput,
    tryReport: (input: LocalEvalRuntimeEventInput) => boolean,
  ): 'queued' | 'buffered' {
    if (tryReport(input)) return 'queued';
    this.prune();
    const buffered = this.bufferedBySession.get(sessionId) ?? [];
    buffered.push({ bufferedAt: this.nowMs(), input });
    if (buffered.length > MAX_BUFFERED_RUNTIME_EVENTS_PER_SESSION) {
      const droppedCount = buffered.length - MAX_BUFFERED_RUNTIME_EVENTS_PER_SESSION;
      buffered.splice(0, droppedCount);
      logger.warn(
        { sessionId, droppedCount, maxEvents: MAX_BUFFERED_RUNTIME_EVENTS_PER_SESSION },
        '[eval-capture] dropped oldest buffered runtime events',
      );
    }
    this.bufferedBySession.set(sessionId, buffered);
    return 'buffered';
  }

  drain(sessionId: string): LocalEvalRuntimeEventInput[] {
    this.prune();
    const buffered = this.bufferedBySession.get(sessionId);
    if (!buffered || buffered.length === 0) return [];
    this.bufferedBySession.delete(sessionId);
    return buffered.map((item) => item.input);
  }

  clear(sessionId: string): void {
    this.bufferedBySession.delete(sessionId);
  }

  private prune(): void {
    const cutoff = this.nowMs() - RUNTIME_EVENT_BUFFER_TTL_MS;
    for (const [sessionId, buffered] of this.bufferedBySession) {
      const retained = buffered.filter((item) => item.bufferedAt >= cutoff);
      if (retained.length === 0) this.bufferedBySession.delete(sessionId);
      else if (retained.length !== buffered.length) {
        this.bufferedBySession.set(sessionId, retained);
      }
    }
  }
}
