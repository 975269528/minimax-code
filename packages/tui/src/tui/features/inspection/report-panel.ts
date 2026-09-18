import { panelLayout } from '../../widgets/panel-frame.js';
import { Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { wrapTextWithAnsi } from '../../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { renderTranscriptInspection } from '../../transcript/inspection.js';
import type { TranscriptInspectionReport } from '../../transcript/model.js';

type InspectionPanelState =
  | { readonly kind: 'loading'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly content: string;
      readonly inspection?: TranscriptInspectionReport;
    }
  | { readonly kind: 'error'; readonly message: string };

export interface TuiReportInspectionPanelOptions {
  readonly title: string;
  readonly loadingMessage: string;
  readonly maxRows?: number | (() => number);
  readonly requestRender: () => void;
  readonly onCancel: () => void;
  readonly onDispose?: () => void;
}

/**
 * Local inspection rendered in the single interaction slot.
 *
 * The panel is never a Transcript cell: asynchronous results update this
 * component in place, and closing it disposes the complete visual lifetime.
 */
export class TuiReportInspectionPanel implements Component, Focusable {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private _focused = false;
  private disposed = false;
  private scrollOffset = 0;
  private lastPageSize = 1;
  private lastMaxScrollOffset = 0;
  private state: InspectionPanelState;

  constructor(private readonly options: TuiReportInspectionPanelOptions) {
    this.state = { kind: 'loading', message: options.loadingMessage };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  setResult(content: string, inspection?: TranscriptInspectionReport): void {
    if (this.disposed) return;
    const wasReady = this.state.kind === 'ready';
    this.state = { kind: 'ready', content, ...(inspection ? { inspection } : {}) };
    if (!wasReady) this.resetScroll();
    this.options.requestRender();
  }

  setError(message: string): void {
    if (this.disposed) return;
    this.state = { kind: 'error', message };
    this.resetScroll();
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) this.scrollByRows(-1);
    else if (matchesKey(data, Key.down)) this.scrollByRows(1);
    else if (matchesKey(data, Key.pageUp)) this.scrollByPage(-1);
    else if (matchesKey(data, Key.pageDown)) this.scrollByPage(1);
  }

  scrollByRows(delta: number): number {
    const before = this.scrollOffset;
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.lastMaxScrollOffset));
    if (this.scrollOffset !== before) this.options.requestRender();
    return this.scrollOffset - before;
  }

  scrollByPage(direction: -1 | 1): number {
    return this.scrollByRows(direction * this.lastPageSize);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderFrame(width, resolveMaxRows(this.options.maxRows));
  }

  renderViewport(width: number, height: number): string[] {
    const viewportRows = Math.max(1, Math.floor(height));
    const configuredRows = resolveMaxRows(this.options.maxRows);
    return this.renderFrame(
      width,
      configuredRows === undefined ? viewportRows : Math.min(viewportRows, configuredRows),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.onDispose?.();
  }

  private renderFrame(rawWidth: number, maxRows: number | undefined): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    if (width === 0) return [];
    const initial = panelLayout(width, maxRows, 'Esc close');
    const body = this.renderBody(initial.contentWidth);
    const progress = (start: number, end: number) =>
      `${start}-${end}/${body.length} · ↑↓ scroll · PgUp/PgDn scroll · Esc close`;
    const layout =
      body.length > initial.bodyHeight
        ? panelLayout(width, maxRows, progress(body.length, body.length))
        : initial;
    const pageSize = Math.max(1, layout.bodyHeight);
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset, Math.max(0, body.length - pageSize)),
    );
    this.lastPageSize = pageSize;
    this.lastMaxScrollOffset = Math.max(0, body.length - pageSize);
    return panelLayout(
      width,
      maxRows,
      this.lastMaxScrollOffset > 0
        ? progress(this.scrollOffset + 1, Math.min(body.length, this.scrollOffset + pageSize))
        : 'Esc close',
    ).render({
      title: cleanInline(this.options.title),
      body: body.slice(this.scrollOffset, this.scrollOffset + pageSize),
    });
  }

  private renderBody(width: number): string[] {
    if (this.state.kind === 'ready' && this.state.inspection) {
      return renderTranscriptInspection(this.state.inspection, width);
    }

    const message =
      this.state.kind === 'loading'
        ? chalk.hex(colors.muted)(cleanText(this.state.message))
        : this.state.kind === 'error'
          ? chalk.hex(colors.error)(cleanText(this.state.message))
          : chalk.hex(colors.text)(cleanText(this.state.content));
    return wrapMultiline(message, width);
  }

  private resetScroll(): void {
    this.scrollOffset = 0;
    this.lastPageSize = 1;
    this.lastMaxScrollOffset = 0;
  }
}

function resolveMaxRows(value: number | (() => number) | undefined): number | undefined {
  const rows = typeof value === 'function' ? value() : value;
  return rows === undefined || !Number.isFinite(rows) ? undefined : Math.max(2, Math.floor(rows));
}

function wrapMultiline(value: string, width: number): string[] {
  return value
    .split('\n')
    .flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : ['']));
}

function cleanText(value: string): string {
  return sanitizeTerminalText(value).trim();
}

function cleanInline(value: string): string {
  return cleanText(value).replace(/\s+/gu, ' ');
}
