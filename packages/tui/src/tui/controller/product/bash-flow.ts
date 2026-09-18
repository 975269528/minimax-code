import { executeTuiBash, type ExecuteTuiBash } from '../../../host/bash-command.js';
import type { TuiBashInput } from '../../commands/bash-input.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TranscriptStore } from '../../transcript/store.js';

const MAX_OUTPUT_CHARACTERS = 64 * 1024;
const MAX_CONTEXT_CHARACTERS = 64 * 1024;

export interface TuiBashFlowOptions {
  readonly transcript: TranscriptStore;
  readonly execute?: ExecuteTuiBash;
  readonly onChanged: () => void;
}

/** Owns user-started shell processes and output awaiting the next message. */
export class TuiBashFlow {
  private active: { abort: AbortController; done: Promise<void> } | undefined;
  private sequence = 0;
  private readonly pendingContext = new Map<string, string>();

  constructor(private readonly options: TuiBashFlowOptions) {}

  isRunning(): boolean {
    return Boolean(this.active);
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.abort.abort();
    return true;
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.active?.done;
    this.pendingContext.clear();
  }

  async run(input: TuiBashInput, cwd: string, sessionId?: string): Promise<void> {
    if (this.active) throw new Error('A shell command is already running.');
    const abort = new AbortController();
    const done = Promise.resolve().then(() => this.execute(input, cwd, sessionId, abort.signal));
    this.active = { abort, done };
    try {
      await done;
    } finally {
      this.active = undefined;
      this.options.onChanged();
    }
  }

  /** The submission snapshot owns this context after taking it, including retries. */
  takeContext(sessionId?: string): string | undefined {
    const key = sessionId ?? 'new-session';
    const context = this.pendingContext.get(key);
    this.pendingContext.delete(key);
    if (!context) return undefined;
    const escaped = context.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    return `<user-provided-context>\nUser-executed shell commands and output:\n${escaped}\n</user-provided-context>`;
  }

  clearUnboundContext(): void {
    this.pendingContext.delete('new-session');
  }

  private async execute(
    input: TuiBashInput,
    cwd: string,
    sessionId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const id = `local:bash:${++this.sequence}`;
    const createdAtMs = Date.now();
    const command = sanitizeTerminalText(input.command);
    let output = '';
    let truncated = false;
    let lastRenderAt = 0;
    let pendingRender: ReturnType<typeof setTimeout> | undefined;
    const clearPendingRender = () => {
      if (pendingRender) clearTimeout(pendingRender);
      pendingRender = undefined;
    };
    const render = (
      status: 'running' | 'succeeded' | 'failed' | 'cancelled',
      footer = 'Running · Esc or Ctrl+C to cancel',
    ) => {
      clearPendingRender();
      this.options.transcript.upsert({
        id,
        kind: 'shell',
        status,
        ephemeral: true,
        title: `${input.excludeFromContext ? '!!' : '!'} ${command}`,
        content: `${truncated ? '[Earlier output truncated]\n' : ''}${sanitizeTerminalText(output)}`,
        detail: footer,
        createdAtMs,
        updatedAtMs: Date.now(),
      });
      lastRenderAt = Date.now();
      this.options.onChanged();
    };
    render('running');
    let footer: string;
    try {
      const result = await (this.options.execute ?? executeTuiBash)({
        command: input.command,
        cwd,
        signal,
        onOutput: (text) => {
          output += text;
          if (output.length > MAX_OUTPUT_CHARACTERS) {
            output = output.slice(-MAX_OUTPUT_CHARACTERS);
            truncated = true;
          }
          const delay = Math.max(0, 50 - (Date.now() - lastRenderAt));
          if (delay === 0) render('running');
          else pendingRender ??= setTimeout(() => render('running'), delay);
        },
      });
      footer = result.cancelled
        ? 'Command cancelled'
        : `Exit code: ${result.exitCode ?? 'unknown'}`;
      render(
        result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'succeeded' : 'failed',
        footer,
      );
    } catch (error) {
      footer = `Could not run command: ${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}`;
      render('failed', footer);
    }
    if (!input.excludeFromContext) {
      const key = sessionId ?? 'new-session';
      const entry = `$ ${command}\nWorking directory: ${cwd}\n${truncated ? '[Earlier output truncated]\n' : ''}${sanitizeTerminalText(output)}\n${footer}`;
      const previous = this.pendingContext.get(key);
      const combined = previous ? `${previous}\n\n${entry}` : entry;
      this.pendingContext.set(
        key,
        combined.length > MAX_CONTEXT_CHARACTERS
          ? `[Earlier command context truncated]\n${combined.slice(-MAX_CONTEXT_CHARACTERS)}`
          : combined,
      );
    }
  }
}
