import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

import type { TuiCustomStatusLineConfig } from '@mavis/config';

import { parseTuiExternalEditorCommand } from './external-editor.js';

export type { TuiCustomStatusLineConfig } from '@mavis/config';

/**
 * Custom status command runner.
 *
 * Executes the user-configured `tui.customStatusLine.command` and surfaces the
 * bounded stdout as the `custom-command` inline item or multiline block. The command is
 * a user-owned integration point (environment, build status, usage probes, …), so the
 * runner is deliberately defensive:
 *
 * - It only exists when `tui.statusLine` names `custom-command` without
 *   `build-mode`; the owner enforces that gate before construction, so a
 *   build-mode TUI never spawns the command at all.
 * - One run in flight at a time. Triggers that arrive while a run is active
 *   collapse into a single trailing rerun (latest event wins), so a slow
 *   command can never queue unbounded work.
 * - A failed or timed-out run reports nothing: the owner keeps the last
 *   successful text instead of flickering the item.
 *
 * Stdin carries a small JSON payload describing why the run happened; the
 * field names are snake_case to match common external statusline protocols.
 */

export const TUI_CUSTOM_STATUS_PROTOCOL_VERSION = 1;

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_SECONDS = 10;
/** Stdout beyond this UTF-16 code-unit budget is discarded before rendering. */
const MAX_STDOUT_LENGTH = 8 * 1024;

export type TuiCustomStatusEvent =
  | 'startup'
  | 'turn-end'
  | 'session-change'
  | 'workspace-change'
  | 'interval';

/** Facts about the active Session at the moment a run starts. */
export interface TuiCustomStatusContext {
  readonly sessionId?: string;
  readonly workspaceDir: string;
  readonly model?: string;
  readonly sessionTitle?: string;
}

export interface TuiCustomStatusProcessInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: boolean;
  /** JSON payload written to the child's stdin before it is closed. */
  readonly stdin: string;
  readonly timeoutMs: number;
}

export interface TuiCustomStatusProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export type TuiCustomStatusProcessRunner = (
  invocation: TuiCustomStatusProcessInvocation,
) => Promise<TuiCustomStatusProcessResult>;

export interface CreateTuiCustomStatusCommandRunnerOptions {
  readonly config: TuiCustomStatusLineConfig;
  /** TUI version reported to the command as `tui_version`. */
  readonly version: string;
  /** Snapshot provider; read at run start so interval runs see fresh facts. */
  readonly getContext: () => TuiCustomStatusContext;
  /** Called with bounded stdout (the first line in inline display) after a successful run. */
  readonly onText: (text: string) => void;
  readonly platform?: NodeJS.Platform;
  readonly runProcess?: TuiCustomStatusProcessRunner;
}

export class TuiCustomStatusCommandRunner {
  private readonly parsed: { executable: string; args: readonly string[] } | undefined;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly shell: boolean;
  private readonly runProcess: TuiCustomStatusProcessRunner;
  private intervalTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private trailing: TuiCustomStatusEvent | undefined;
  private disposed = false;
  private paused = false;
  private contextGeneration = 0;

  constructor(private readonly options: CreateTuiCustomStatusCommandRunnerOptions) {
    this.parsed = parseCustomStatusCommand(options.config.command);
    this.timeoutMs = normalizeTimeoutMs(options.config.timeoutMs);
    this.intervalMs = normalizeIntervalMs(options.config.intervalSeconds);
    // Same Windows path as the external editor: an async shell child keeps
    // console handling out of the TUI's raw-mode input loop.
    this.shell = (options.platform ?? process.platform) === 'win32';
    this.runProcess = options.runProcess ?? runCustomStatusProcess;
  }

  /** Runs the startup refresh and arms the optional interval timer. */
  start(): void {
    if (this.disposed || this.paused || !this.parsed) return;
    this.trigger('startup');
    if (this.intervalMs > 0) {
      this.intervalTimer = setInterval(() => this.trigger('interval'), this.intervalMs);
      this.intervalTimer.unref?.();
    }
  }

  /**
   * Requests a refresh for `event`. Coalesces while a run is in flight: the
   * latest trigger becomes one trailing rerun after the active run settles.
   */
  trigger(event: TuiCustomStatusEvent): void {
    if (this.disposed || this.paused || !this.parsed) return;
    if (event === 'session-change' || event === 'workspace-change') this.contextGeneration += 1;
    if (this.running) {
      this.trailing = event;
      return;
    }
    void this.run(event);
  }

  dispose(): void {
    this.disposed = true;
    this.pause();
  }

  /** Disable future work without losing the in-flight process serialization guard. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.contextGeneration += 1;
    this.trailing = undefined;
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.intervalTimer = undefined;
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    this.start();
  }

  private async run(event: TuiCustomStatusEvent): Promise<void> {
    if (!this.parsed) return;
    this.running = true;
    const contextGeneration = this.contextGeneration;
    try {
      const context = this.options.getContext();
      const result = await this.runProcess({
        executable: this.parsed.executable,
        args: this.parsed.args,
        cwd: context.workspaceDir,
        shell: this.shell,
        stdin: buildCustomStatusPayload(event, context, this.options.version),
        timeoutMs: this.timeoutMs,
      });
      if (this.disposed || contextGeneration !== this.contextGeneration) return;
      if (!result.timedOut && result.exitCode === 0) {
        this.options.onText(
          extractCustomStatusText(result.stdout, this.options.config.display === 'block'),
        );
      }
    } catch {
      // A crashing or unspawnable command keeps the last successful text.
    } finally {
      this.running = false;
      const next = this.trailing;
      this.trailing = undefined;
      if (next !== undefined && !this.disposed && !this.paused) void this.run(next);
    }
  }
}

/**
 * Creates the runner only when every gate holds: `custom-command` is actually
 * configured to render, `build-mode` does not own the line, and a command
 * exists. Returns `undefined` otherwise so callers get the zero-spawn
 * guarantee for free.
 */
export function createTuiCustomStatusCommandRunner(
  statusLineItems: readonly string[] | undefined,
  options: CreateTuiCustomStatusCommandRunnerOptions,
): TuiCustomStatusCommandRunner | undefined {
  if (!statusLineItems?.includes('custom-command')) return undefined;
  if (statusLineItems.includes('build-mode')) return undefined;
  if (!options.config.command?.trim()) return undefined;
  return new TuiCustomStatusCommandRunner(options);
}

function parseCustomStatusCommand(
  command: string | undefined,
): { executable: string; args: readonly string[] } | undefined {
  if (!command?.trim()) return undefined;
  try {
    return parseTuiExternalEditorCommand(command);
  } catch {
    // A malformed command (unbalanced quote, …) disables the item instead of
    // failing TUI startup.
    return undefined;
  }
}

function buildCustomStatusPayload(
  event: TuiCustomStatusEvent,
  context: TuiCustomStatusContext,
  version: string,
): string {
  return `${JSON.stringify({
    protocol: TUI_CUSTOM_STATUS_PROTOCOL_VERSION,
    event,
    ...(context.sessionId ? { session_id: context.sessionId } : {}),
    workspace_dir: context.workspaceDir,
    ...(context.model ? { model: context.model } : {}),
    ...(context.sessionTitle ? { session_title: context.sessionTitle } : {}),
    tui_version: version,
  })}\n`;
}

/** Preserve bounded stdout for block display; sanitization happens at render time. */
function extractCustomStatusText(stdout: string, block: boolean): string {
  const bounded = stdout.slice(0, MAX_STDOUT_LENGTH);
  if (block) return bounded;
  const firstLine = bounded.split(/\r?\n/u, 1)[0] ?? '';
  return firstLine.trim();
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)));
}

function normalizeIntervalMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.max(MIN_INTERVAL_SECONDS, Math.floor(value)) * 1_000;
}

function runCustomStatusProcess(
  invocation: TuiCustomStatusProcessInvocation,
): Promise<TuiCustomStatusProcessResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const settle = (result: TuiCustomStatusProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child?.stdin?.destroy();
      child?.stdout?.destroy();
      resolve(result);
    };

    try {
      child = spawn(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        shell: invocation.shell,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch {
      settle({ exitCode: null, stdout: '', timedOut: false });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      if (child) terminateCustomStatusProcess(child);
      // A descendant may hold stdout open even after the command exits. Never
      // depend on close to release the runner's single in-flight slot.
      settle({ exitCode: null, stdout, timedOut: true });
    }, invocation.timeoutMs);
    timer.unref?.();

    child.once('error', () => settle({ exitCode: null, stdout: '', timedOut }));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length >= MAX_STDOUT_LENGTH) return;
      stdout += chunk.slice(0, MAX_STDOUT_LENGTH - stdout.length);
    });
    // The command may exit without reading stdin; ignore the EPIPE.
    child.stdin?.on('error', () => {});
    child.stdin?.end(invocation.stdin);
    child.once('close', (exitCode) => settle({ exitCode, stdout, timedOut }));
  });
}

function terminateCustomStatusProcess(child: ReturnType<typeof spawn>): void {
  const killRoot = () => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The command may already have exited.
    }
  };
  if (!child.pid) return killRoot();
  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, 'SIGKILL');
      return;
    }
    const root = process.env.SystemRoot ?? process.env.WINDIR;
    const taskkill = root ? win32.join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', killRoot);
    killer.once('close', (code) => {
      if (code !== 0) killRoot();
    });
    killer.unref();
  } catch {
    killRoot();
  }
}
