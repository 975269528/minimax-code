import { panelLayout } from '../../widgets/panel-frame.js';
import { decodePrintableKey, getKeybindings, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { truncateToWidth } from '../../rendering/text.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import { Input } from '../../widgets/input.js';
import { formatTuiActionFailure } from '../../../user-facing-failure.js';

export interface TuiQueuePanelItem {
  readonly itemId: string;
  readonly status?: 'queued' | 'paused' | 'failed';
  readonly content: string;
  readonly attachmentNames: readonly string[];
  readonly failedReason?: string;
}

type QueuePanelMode = 'list' | 'edit' | 'confirm-delete';

export interface TuiQueuePanelOptions {
  readonly items: readonly TuiQueuePanelItem[];
  readonly initialItemId?: string;
  readonly summary?: { readonly paused: boolean; readonly pendingCount: number };
  onContinue?(): Promise<boolean>;
  onUpdate(itemId: string, content: string): Promise<boolean>;
  onDelete(itemId: string): Promise<boolean>;
  onRestore?(itemId: string): Promise<boolean>;
  onRetry?(itemId: string): Promise<boolean>;
  onCancel(): void;
  requestRender(): void;
}

export class TuiQueuePanel implements Component, Focusable {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private items: TuiQueuePanelItem[];
  private readonly input = new Input();
  private mode: QueuePanelMode = 'list';
  private selectedIndex = 0;
  private busy = false;
  private status?: { tone: 'info' | 'error'; text: string };
  private _focused = false;
  private disposed = false;
  private summary: { readonly paused: boolean; readonly pendingCount: number };
  private listViewport:
    | { readonly start: number; readonly end: number; readonly selectedRow: number }
    | undefined;

  constructor(private readonly options: TuiQueuePanelOptions) {
    this.items = [...options.items];
    this.summary = options.summary ?? { paused: false, pendingCount: options.items.length };
    const initialIndex = options.initialItemId
      ? this.items.findIndex((item) => item.itemId === options.initialItemId)
      : -1;
    this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, this.items.length - 1);
    this.input.onSubmit = (value) => void this.submitEdit(value);
    this.input.onEscape = () => this.leaveActionMode();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.mode === 'edit';
  }

  setItems(items: readonly TuiQueuePanelItem[]): void {
    if (this.disposed) return;
    const selectedId = this.selected()?.itemId;
    this.items = [...items];
    const nextIndex = selectedId ? this.items.findIndex((item) => item.itemId === selectedId) : -1;
    if (nextIndex >= 0) this.selectedIndex = nextIndex;
    else this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.items.length - 1));
    if (this.mode !== 'list' && selectedId && nextIndex < 0) {
      this.mode = 'list';
      this.status = { tone: 'error', text: 'That message has already started.' };
    }
    this.syncInputFocus();
    this.requestRender();
  }

  setQueueSummary(summary: { readonly paused: boolean; readonly pendingCount: number }): void {
    this.summary = summary;
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    if (this.mode === 'edit') {
      this.input.handleInput(data);
      this.requestRender();
      return;
    }
    if (this.mode === 'confirm-delete') {
      if (matchesKey(data, 'enter')) void this.confirmDelete();
      else if (getKeybindings().matches(data, 'tui.select.cancel')) this.leaveActionMode();
      return;
    }
    if (matchesKey(data, 'up')) {
      this.move(-1);
      return;
    }
    if (matchesKey(data, 'down')) {
      this.move(1);
      return;
    }
    if (matchesKey(data, 'enter')) {
      if (this.selected()?.status === 'failed') void this.retrySelected();
      else this.beginEdit();
      return;
    }
    if (getKeybindings().matches(data, 'tui.select.cancel')) {
      this.options.onCancel();
      return;
    }
    const printable = decodePrintableKey(data) ?? data;
    if (printable.toLocaleLowerCase() === 'c' && this.summary.paused && this.options.onContinue) {
      void this.continueQueue();
      return;
    }
    if (printable.toLocaleLowerCase() === 'e') {
      this.beginEdit();
      return;
    }
    if (printable.toLocaleLowerCase() === 'r' && this.options.onRestore) {
      void this.restoreSelected();
      return;
    }
    if (printable.toLocaleLowerCase() === 'd') this.beginDelete();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.input.focused = false;
  }

  private renderContent(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth < 4) return [];
    const lines = [
      chalk.hex(colors.muted)(
        this.summary.paused
          ? `Paused · ${this.summary.pendingCount} pending. Continue when ready.`
          : 'Runs in this order after the current response.',
      ),
      '',
    ];
    this.listViewport = undefined;
    if (this.items.length === 0) {
      lines.push(
        chalk.hex(colors.warning)(
          this.summary.paused && this.summary.pendingCount > 0
            ? 'Background work is waiting to continue.'
            : 'No next messages.',
        ),
      );
    } else if (this.mode === 'edit') {
      const selected = this.selected();
      lines.push(chalk.bold.hex(colors.text)('Edit next message'));
      if (selected?.attachmentNames.length) {
        lines.push(
          chalk.hex(colors.muted)(
            `Attachments stay unchanged · ${formatAttachmentNames(selected.attachmentNames)}`,
          ),
        );
      }
      lines.push(this.input.render(Math.max(1, safeWidth))[0] ?? '');
    } else if (this.mode === 'confirm-delete') {
      const selected = this.selected();
      lines.push(chalk.bold.hex(colors.error)('Remove this next message?'));
      if (selected) lines.push(chalk.hex(colors.text)(preview(selected)));
    } else {
      const listStart = lines.length;
      let selectedRow = listStart;
      for (const [index, item] of this.items.entries()) {
        const marker = index === this.selectedIndex ? '›' : ' ';
        const color =
          index === this.selectedIndex ? chalk.bold.hex(colors.signal) : chalk.hex(colors.muted);
        const state = item.status === 'failed' ? `[${chalk.hex(colors.error)('failed')}] ` : '';
        if (index === this.selectedIndex) selectedRow = lines.length;
        lines.push(color(`${marker} ${String(index + 1)}. ${state}${preview(item)}`));
        if (index === this.selectedIndex && item.failedReason) {
          lines.push(chalk.hex(colors.error)(`    ${sanitizeTerminalText(item.failedReason)}`));
        }
      }
      this.listViewport = { start: listStart, end: lines.length, selectedRow };
    }
    if (this.status) {
      lines.push(
        this.status.tone === 'error'
          ? chalk.hex(colors.error)(`! ${this.status.text}`)
          : chalk.hex(colors.accent)(this.status.text),
      );
    }
    return lines.map((line) => truncateToWidth(line, safeWidth, chalk.hex(colors.dim)('…')));
  }

  render(width: number): string[] {
    return this.renderViewport(width, 24);
  }

  renderViewport(width: number, height: number): string[] {
    const hint =
      this.mode === 'edit'
        ? 'Enter save · Esc cancel'
        : this.mode === 'confirm-delete'
          ? 'Enter remove · Esc keep'
          : `${this.summary.paused && this.options.onContinue ? 'c continue queue · ' : ''}↑↓ select · Enter ${this.selected()?.status === 'failed' ? 'retry' : 'edit'}${this.options.onRestore ? ' · r restore' : ''}${this.selected()?.status === 'failed' ? ' · e edit · d discard' : ' · d remove'} · Esc close`;
    const layout = panelLayout(width, height, hint);
    const content = this.renderContent(layout.contentWidth);
    const viewport = this.listViewport;
    let body = content;
    if (viewport && content.length > layout.bodyHeight) {
      const prefix = content.slice(0, viewport.start);
      const suffix = content.slice(viewport.end);
      const available = layout.bodyHeight - prefix.length - suffix.length;
      if (available <= 0) body = [content[viewport.selectedRow] ?? '', ...suffix];
      else {
        const relativeSelected = viewport.selectedRow - viewport.start;
        const start = Math.max(
          0,
          Math.min(
            relativeSelected - Math.floor(available / 2),
            viewport.end - viewport.start - available,
          ),
        );
        body = [
          ...prefix,
          ...content.slice(viewport.start + start, viewport.start + start + available),
          ...suffix,
        ];
      }
    }
    return layout.render({
      title: 'Queue',
      meta: `${this.items.filter((item) => item.status !== 'failed').length} next · ${this.items.filter((item) => item.status === 'failed').length} failed`,
      body,
    });
  }

  private selected(): TuiQueuePanelItem | undefined {
    return this.items[this.selectedIndex];
  }

  private async continueQueue(): Promise<void> {
    this.busy = true;
    this.requestRender();
    try {
      const continued = await this.options.onContinue?.();
      if (!this.disposed)
        this.status = {
          tone: continued ? 'info' : 'error',
          text: continued
            ? 'Queue continued.'
            : 'The Queue could not continue. Check the current response or provider settings.',
        };
    } catch (error) {
      if (!this.disposed)
        this.status = {
          tone: 'error',
          text: formatTuiActionFailure(error, {
            summary: "Couldn't continue the Queue.",
            nextStep: 'Check the provider settings and retry.',
          }),
        };
    } finally {
      this.busy = false;
      this.requestRender();
    }
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
    this.status = undefined;
    this.requestRender();
  }

  private beginEdit(): void {
    const selected = this.selected();
    if (!selected) return;
    this.mode = 'edit';
    this.status = undefined;
    this.input.setValue(selected.content);
    this.input.moveCursorToEnd();
    this.syncInputFocus();
    this.requestRender();
  }

  private beginDelete(): void {
    if (!this.selected()) return;
    this.mode = 'confirm-delete';
    this.status = undefined;
    this.syncInputFocus();
    this.requestRender();
  }

  private leaveActionMode(): void {
    this.mode = 'list';
    this.status = undefined;
    this.syncInputFocus();
    this.requestRender();
  }

  private async submitEdit(value: string): Promise<void> {
    const selected = this.selected();
    if (!selected) return;
    const content = value.trim();
    if (!content && selected.attachmentNames.length === 0) {
      this.status = { tone: 'error', text: 'A next message cannot be empty.' };
      this.requestRender();
      return;
    }
    this.busy = true;
    this.requestRender();
    try {
      const updated = await this.options.onUpdate(selected.itemId, content);
      if (this.disposed) return;
      if (updated) {
        this.mode = 'list';
        this.status = { tone: 'info', text: 'Next message updated.' };
      } else {
        this.mode = 'list';
        this.status = { tone: 'error', text: 'That message has already started.' };
      }
    } catch (error) {
      if (this.disposed) return;
      this.status = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: "Couldn't update this next message.",
          nextStep: 'Retry.',
          preservation: 'Your original message is unchanged.',
        }),
      };
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.syncInputFocus();
        this.requestRender();
      }
    }
  }

  private async confirmDelete(): Promise<void> {
    const selected = this.selected();
    if (!selected) return;
    this.busy = true;
    this.requestRender();
    try {
      const removed = await this.options.onDelete(selected.itemId);
      if (this.disposed) return;
      this.mode = 'list';
      this.status = removed
        ? { tone: 'info', text: 'Next message removed.' }
        : { tone: 'error', text: 'That message has already started.' };
    } catch (error) {
      if (this.disposed) return;
      this.status = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: "Couldn't remove this next message.",
          nextStep: 'Retry from the Queue.',
        }),
      };
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.syncInputFocus();
        this.requestRender();
      }
    }
  }

  private async retrySelected(): Promise<void> {
    const selected = this.selected();
    if (!selected || selected.status !== 'failed' || !this.options.onRetry) return;
    this.busy = true;
    this.status = { tone: 'info', text: 'Retrying message…' };
    this.requestRender();
    try {
      const retried = await this.options.onRetry(selected.itemId);
      if (this.disposed) return;
      this.status = retried
        ? { tone: 'info', text: 'Message accepted.' }
        : { tone: 'error', text: 'Message is still pending retry.' };
    } catch (error) {
      if (this.disposed) return;
      this.status = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: "Couldn't retry this message.",
          nextStep: 'Retry later.',
          preservation: 'It remains in the Queue.',
        }),
      };
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.requestRender();
      }
    }
  }

  private async restoreSelected(): Promise<void> {
    const selected = this.selected();
    if (!selected || !this.options.onRestore) return;
    this.busy = true;
    this.status = { tone: 'info', text: 'Restoring message…' };
    this.requestRender();
    try {
      const restored = await this.options.onRestore(selected.itemId);
      if (this.disposed) return;
      if (restored) {
        this.status = { tone: 'info', text: 'Message restored to Composer.' };
        this.options.onCancel();
      } else {
        this.status = { tone: 'error', text: 'That message has already started.' };
      }
    } catch (error) {
      if (this.disposed) return;
      this.status = {
        tone: 'error',
        text: formatTuiActionFailure(error, {
          summary: "Couldn't restore this message.",
          nextStep: 'Reopen the Queue to check its state.',
        }),
      };
    } finally {
      if (!this.disposed) {
        this.busy = false;
        this.requestRender();
      }
    }
  }

  private syncInputFocus(): void {
    this.input.focused = this._focused && this.mode === 'edit';
  }

  private requestRender(): void {
    if (!this.disposed) this.options.requestRender();
  }
}

function preview(item: TuiQueuePanelItem): string {
  const content = sanitizeTerminalText(item.content).replace(/\s+/gu, ' ').trim();
  const attachments = formatAttachmentNames(item.attachmentNames);
  return [content || '(attachment-only message)', attachments || undefined]
    .filter(Boolean)
    .join(' · ');
}

function formatAttachmentNames(names: readonly string[]): string {
  return names
    .map((name) => sanitizeTerminalText(name).replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join(', ');
}
