import { panelLayout, panelContentWidth } from '../../widgets/panel-frame.js';
import { Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import type {
  TuiRewindPreview,
  TuiRewindPreviewFile,
  TuiRewindPreviewTurn,
} from '../../../runtime/port.js';
import { describeRewindFileAction } from './format.js';
import { sessionMutationTemplate, sessionMutationText } from './copy.js';

export interface TuiSessionMutationRewindPreviewPanelOptions {
  readonly preview: TuiRewindPreview;
  readonly onCancel: () => void;
  readonly onContinue?: () => void;
  readonly requestRender?: () => void;
  readonly target?: string;
  readonly impact?: string;
  readonly continueHint?: string;
  /**
   * Optional heading override; defaults to "Rewind preview".
   * Exposed so the panel can be re-used by future flows (e.g. dry-run
   * confirmation) without copying the rendering logic.
   */
  readonly heading?: string;
}

interface FileGroup {
  readonly status: 'ready' | 'skipped';
  readonly files: ReadonlyArray<{
    readonly file: TuiRewindPreviewFile;
    readonly actionLabel: string;
  }>;
}

function bucketFiles(turns: readonly TuiRewindPreviewTurn[]): {
  ready: FileGroup;
  skipped: FileGroup;
  totalReady: number;
  totalSkipped: number;
} {
  const readyList: { file: TuiRewindPreviewFile; actionLabel: string }[] = [];
  const skippedList: { file: TuiRewindPreviewFile; actionLabel: string }[] = [];
  for (const turn of turns) {
    for (const file of turn.files) {
      const badge = describeRewindFileAction(file);
      if (badge.status === 'skipped') skippedList.push({ file, actionLabel: badge.actionLabel });
      else readyList.push({ file, actionLabel: badge.actionLabel });
    }
  }
  return {
    ready: { status: 'ready', files: readyList },
    skipped: { status: 'skipped', files: skippedList },
    totalReady: readyList.length,
    totalSkipped: skippedList.length,
  };
}

export class TuiSessionMutationRewindPreviewPanel
  implements TuiFeatureScreen, Component, Focusable
{
  readonly id = 'session-mutation:rewind-preview';
  readonly layoutRoot: Component = this;
  readonly handlesViewportKeys = true;
  private _focused = false;
  private closed = false;
  private busy = false;
  private error?: string;
  private scrollOffset = 0;
  private pageSize = 1;
  private maxScrollOffset = 0;

  constructor(private readonly options: TuiSessionMutationRewindPreviewPanelOptions) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (this.busy) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.close();
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (this.options.onContinue) this.options.onContinue();
      else this.close();
      return;
    }
    if (matchesKey(data, 'up')) return this.scroll(-1);
    if (matchesKey(data, 'down')) return this.scroll(1);
    if (matchesKey(data, Key.pageUp)) return this.scroll(-this.pageSize);
    if (matchesKey(data, Key.pageDown)) return this.scroll(this.pageSize);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    return this.renderViewport(safeWidth, Number.MAX_SAFE_INTEGER);
  }

  renderViewport(width: number, height: number): string[] {
    const safeWidth = panelContentWidth(width, width >= 12 && height >= 6);
    const safeHeight = Math.max(1, Math.floor(height));
    if (safeWidth === 0) return [];
    const { ready, skipped, totalReady, totalSkipped } = bucketFiles(this.options.preview.turns);
    const heading = sanitizeTerminalText(
      this.options.heading ?? sessionMutationText('sessionMutation.preview.heading'),
    );
    const header: string[] = [
      chalk.hex(colors.muted)(
        fit(
          this.summaryLine(totalReady, totalSkipped, this.options.preview.turns.length),
          safeWidth,
        ),
      ),
    ];
    if (this.options.target) {
      header.push(
        chalk.bold.hex(colors.text)(fit(sanitizeTerminalText(this.options.target), safeWidth)),
      );
    }
    if (this.options.impact) {
      header.push(
        chalk.hex(colors.muted)(fit(sanitizeTerminalText(this.options.impact), safeWidth)),
      );
    }
    header.push('');
    const body: string[] = [];
    if (totalReady === 0 && totalSkipped === 0) {
      body.push(
        chalk.hex(colors.muted)(
          fit(sessionMutationText('sessionMutation.preview.empty'), safeWidth),
        ),
      );
    } else if (totalReady === 0) {
      // Nothing the user can actually rewind — surface a clear no-diff message
      // so the caller can fall back to a conversation-only confirmation.
      body.push(
        chalk.hex(colors.warning)(
          fit(sessionMutationText('sessionMutation.preview.noSafe'), safeWidth),
        ),
      );
    } else {
      body.push(
        chalk.bold.hex(colors.text)(
          fit(sessionMutationText('sessionMutation.preview.ready'), safeWidth),
        ),
      );
      body.push(...this.renderGroup(ready, safeWidth, colors.success));
    }
    if (totalSkipped > 0) {
      body.push('');
      body.push(
        chalk.bold.hex(colors.text)(
          fit(sessionMutationText('sessionMutation.preview.skipped'), safeWidth),
        ),
      );
      body.push(...this.renderGroup(skipped, safeWidth, colors.muted));
    }
    const baseHint =
      this.options.continueHint ??
      (this.options.onContinue
        ? sessionMutationText('sessionMutation.preview.rewindHint')
        : sessionMutationText('sessionMutation.preview.close'));
    const availableBodyRows = Math.max(
      1,
      panelLayout(width, safeHeight, baseHint).bodyHeight - header.length - (this.error ? 1 : 0),
    );
    const overflow = body.length > availableBodyRows;
    const footer = [
      ...(this.error
        ? [chalk.hex(colors.warning)(fit(sanitizeTerminalText(this.error), safeWidth))]
        : []),
      ...(overflow
        ? [renderTuiActionHint(sessionMutationText('sessionMutation.preview.scrollHint'))]
        : []),
      '',
      this.busy
        ? chalk.hex(colors.signal)(sessionMutationText('sessionMutation.preview.loading'))
        : renderTuiActionHint(baseHint),
    ];
    const layout = panelLayout(width, height, footer.filter(Boolean));
    const visibleHeader = header.slice(0, Math.max(0, layout.bodyHeight - 1));
    this.pageSize = Math.max(0, layout.bodyHeight - visibleHeader.length);
    this.maxScrollOffset = Math.max(0, body.length - this.pageSize);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.maxScrollOffset));
    return layout.render({
      title: heading,
      body: [...visibleHeader, ...body.slice(this.scrollOffset, this.scrollOffset + this.pageSize)],
    });
  }

  isClosed(): boolean {
    return this.closed;
  }

  setBusy(value: boolean): void {
    this.busy = value;
    if (value) this.error = undefined;
    this.options.requestRender?.();
  }

  setError(value: string): void {
    this.error = value;
    this.options.requestRender?.();
  }

  private scroll(delta: number): void {
    const next = Math.max(0, Math.min(this.maxScrollOffset, this.scrollOffset + delta));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.options.requestRender?.();
  }

  private renderGroup(group: FileGroup, width: number, color: string): string[] {
    if (group.files.length === 0) return [];
    return group.files.map(({ file, actionLabel }) => {
      const path = sanitizeTerminalText(file.filePath);
      const label = `[${actionLabel}] ${path}`;
      return chalk.hex(color)(fit(label, width));
    });
  }

  private summaryLine(ready: number, skipped: number, turnCount: number): string {
    const turns = sessionMutationTemplate(
      turnCount === 1 ? 'sessionMutation.format.turn.one' : 'sessionMutation.format.turn.many',
      { count: turnCount },
    );
    if (ready === 0 && skipped === 0) {
      return sessionMutationTemplate('sessionMutation.preview.summaryEmpty', { turns });
    }
    return sessionMutationTemplate('sessionMutation.preview.summary', { ready, skipped, turns });
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.onCancel();
  }
}

function fit(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  return truncateToWidth(value, width, chalk.hex(colors.dim)('\u2026'));
}
