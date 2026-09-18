import type { CanonicalHistoryMessage, CurrentCanonicalHistoryReader } from './history-store.js';

export interface CanonicalHistoryDebugSessionReader {
  get(sessionId: string): Promise<{ readonly createdAtMs: number } | undefined>;
}

export interface CanonicalHistoryDebugExport {
  readonly sessionId: string;
  readonly exportedAtMs: number;
  readonly messages: readonly CanonicalHistoryMessage[];
}

export interface CanonicalHistoryDebugServiceOptions {
  readonly sessions: CanonicalHistoryDebugSessionReader;
  readonly history: CurrentCanonicalHistoryReader;
  readonly nowMs?: () => number;
}

/** Diagnostic projection over the current v2 canonical messages.jsonl only. */
export class CanonicalHistoryDebugService {
  private readonly nowMs: () => number;

  constructor(private readonly options: CanonicalHistoryDebugServiceOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async readCurrentHistoryExport(
    sessionId: string,
  ): Promise<CanonicalHistoryDebugExport | undefined> {
    const session = await this.options.sessions.get(sessionId);
    if (!session) return undefined;
    const messages = await this.options.history.readCurrentHistory(sessionId, session.createdAtMs);
    return { sessionId, exportedAtMs: this.nowMs(), messages };
  }
}
