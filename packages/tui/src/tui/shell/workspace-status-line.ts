import {
  createTuiCustomStatusCommandRunner,
  type TuiCustomStatusCommandRunner,
  type TuiCustomStatusLineConfig,
  type TuiCustomStatusProcessRunner,
} from '../../host/custom-status-command.js';
import type { TuiWorkspaceGitMetadata, TuiWorkspaceGitPort } from '../../runtime/port.js';
import { TuiStatusLine, type TuiShellState } from './chrome.js';
import {
  parseTuiStatusLineItems,
  TUI_STATUS_LINE_DEFAULT_ITEMS,
  type TuiStatusLineItem,
} from './status-line-items.js';

const WORKSPACE_GIT_REFRESH_INTERVAL_MS = 10_000;

export interface CreateTuiWorkspaceStatusLineOptions {
  runtime: TuiWorkspaceGitPort;
  workspaceDir: string;
  version: string;
  homeDir?: string;
  /**
   * Configured status line item ids, in display order. Unknown ids are
   * ignored. Omit to use the default order; pass an empty array to blank the
   * status line. Naming `build-mode` opts into the status protocol.
   */
  statusLineItems?: readonly string[];
  /**
   * Custom status command settings. The command only runs when
   * `statusLineItems` names `custom-command` without `build-mode`.
   */
  customStatusLine?: TuiCustomStatusLineConfig;
  /** Test seam for the custom status command child process. */
  runCustomStatusProcess?: TuiCustomStatusProcessRunner;
}

export function createTuiWorkspaceStatusLine(
  options: CreateTuiWorkspaceStatusLineOptions,
  requestRender: () => void,
): TuiWorkspaceStatusLine {
  const statusLineItems = options.statusLineItems
    ? parseTuiStatusLineItems(options.statusLineItems)
    : undefined;
  return new TuiWorkspaceStatusLine(
    {
      version: options.version,
      ...(statusLineItems ? { statusLineItems } : {}),
      workspace: options.workspaceDir,
      homeDir: options.homeDir,
      runtimeStatus: 'starting',
    },
    options.runtime,
    requestRender,
    {
      ...(options.customStatusLine ? { customStatusLine: options.customStatusLine } : {}),
      ...(options.runCustomStatusProcess
        ? { runCustomStatusProcess: options.runCustomStatusProcess }
        : {}),
    },
  );
}

export interface TuiWorkspaceStatusLineCustomStatusOptions {
  readonly customStatusLine?: TuiCustomStatusLineConfig;
  readonly runCustomStatusProcess?: TuiCustomStatusProcessRunner;
}

export class TuiWorkspaceStatusLine extends TuiStatusLine {
  private shellState: TuiShellState;
  private statusLineItems: TuiShellState['statusLineItems'];
  private workspaceGit: TuiWorkspaceGitMetadata | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshSequence = 0;
  private disposed = false;
  private customStatusRunner: TuiCustomStatusCommandRunner | undefined;
  private customStatusText: string | undefined;

  constructor(
    initialState: TuiShellState,
    private readonly runtime: TuiWorkspaceGitPort,
    private readonly requestRender: () => void,
    private readonly customStatus: TuiWorkspaceStatusLineCustomStatusOptions = {},
  ) {
    super(initialState, customStatus.customStatusLine);
    this.statusLineItems = initialState.statusLineItems;
    this.shellState = initialState;
    this.syncSources();
  }

  getConfiguredItems(): readonly TuiStatusLineItem[] | undefined {
    return this.statusLineItems?.slice();
  }

  /** Machine mode also owns stores and result delivery, so it remains startup-only. */
  setConfiguredItems(items: readonly TuiStatusLineItem[] | undefined): void {
    if (this.disposed) return;
    if (this.statusLineItems?.includes('build-mode') || items?.includes('build-mode')) {
      throw new Error('build-mode is a startup-only setting');
    }
    this.statusLineItems = items?.slice();
    this.syncSources();
    this.pushState();
    this.requestRender();
  }

  /** Render from current facts without starting Git queries or command processes. */
  preview(items: readonly TuiStatusLineItem[] | undefined, width: number, height: number) {
    const state = this.presentationState();
    const createLine = (selection: readonly TuiStatusLineItem[] | undefined) =>
      new TuiStatusLine(
        { ...state, statusLineItems: selection },
        this.customStatus.customStatusLine,
      );
    return {
      lines: createLine(items).renderViewport(width, height),
      unavailable: (items ?? TUI_STATUS_LINE_DEFAULT_ITEMS).filter(
        (item) => createLine([item]).render(1000).length === 0,
      ),
    };
  }

  private syncSources(): void {
    const items = this.statusLineItems ?? TUI_STATUS_LINE_DEFAULT_ITEMS;
    const needsGit =
      !items.includes('build-mode') &&
      (items.includes('git-branch') || items.includes('review-link'));
    if (needsGit && !this.refreshTimer) {
      void this.refresh();
      this.refreshTimer = setInterval(() => void this.refresh(), WORKSPACE_GIT_REFRESH_INTERVAL_MS);
      this.refreshTimer.unref?.();
    } else if (!needsGit) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
      this.refreshSequence += 1;
      this.workspaceGit = undefined;
    }
    const needsCommand = !items.includes('build-mode') && items.includes('custom-command');
    if (!needsCommand) {
      this.customStatusRunner?.pause();
      this.customStatusText = undefined;
    } else if (this.customStatusRunner) {
      this.customStatusRunner.resume();
    } else {
      this.startCustomCommand();
    }
  }

  private startCustomCommand(): void {
    // The runner factory re-checks every gate (`custom-command` configured,
    // no `build-mode`, command present), so a build-mode TUI never spawns the
    // command — independent of the render-time exclusivity in chrome.
    this.customStatusRunner = this.customStatus.customStatusLine
      ? createTuiCustomStatusCommandRunner(this.statusLineItems, {
          config: this.customStatus.customStatusLine,
          version: this.shellState.version,
          getContext: () => ({
            workspaceDir: this.shellState.workspace,
            ...(this.shellState.agentSessionId
              ? { sessionId: this.shellState.agentSessionId }
              : {}),
            ...(this.shellState.model ? { model: this.shellState.model } : {}),
            ...(this.shellState.sessionTitle ? { sessionTitle: this.shellState.sessionTitle } : {}),
          }),
          onText: (text) => {
            this.customStatusText = text;
            this.pushState();
            this.requestRender();
          },
          ...(this.customStatus.runCustomStatusProcess
            ? { runProcess: this.customStatus.runCustomStatusProcess }
            : {}),
        })
      : undefined;
    this.customStatusRunner?.start();
  }

  override setState(state: TuiShellState): void {
    if (this.disposed) return;
    // The presentation projection does not own the user's current selection.
    const nextState = {
      ...state,
      statusLineItems: this.statusLineItems,
    };
    const runCompleted = this.shellState.busy === true && state.busy !== true;
    const workspaceChanged = this.shellState.workspace !== state.workspace;
    const sessionChanged = this.shellState.agentSessionId !== state.agentSessionId;
    if (workspaceChanged) this.workspaceGit = undefined;
    // A different workspace or Session invalidates the cached command output —
    // a stale cost or quota figure is worse than a briefly missing one.
    if (workspaceChanged || sessionChanged) this.customStatusText = undefined;
    this.shellState = nextState;
    this.pushState();
    if (this.refreshTimer && (workspaceChanged || runCompleted)) void this.refresh();
    if (this.customStatusRunner) {
      if (workspaceChanged) this.customStatusRunner.trigger('workspace-change');
      else if (sessionChanged) this.customStatusRunner.trigger('session-change');
      else if (runCompleted) this.customStatusRunner.trigger('turn-end');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.refreshSequence += 1;
    clearInterval(this.refreshTimer);
    this.customStatusRunner?.dispose();
  }

  /** Pushes the pinned shell state merged with the async side-channels. */
  private pushState(): void {
    super.setState(this.presentationState());
  }

  private presentationState(): TuiShellState {
    return {
      ...this.shellState,
      statusLineItems: this.statusLineItems,
      workspaceGit: this.workspaceGit,
      customStatusText: this.customStatusText,
    };
  }

  private async refresh(): Promise<void> {
    const refreshSequence = ++this.refreshSequence;
    try {
      const metadata = await this.runtime.getWorkspaceGitMetadata(this.shellState.workspace);
      if (this.disposed || refreshSequence !== this.refreshSequence) return;
      this.workspaceGit = metadata;
      this.pushState();
      this.requestRender();
    } catch {
      // Status context is optional; Runtime startup and the TUI stay available when Git is not.
    }
  }
}
