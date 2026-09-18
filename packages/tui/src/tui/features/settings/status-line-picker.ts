import { panelLayout, renderPanelFrame } from '../../widgets/panel-frame.js';
import { getKeybindings, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { visibleWidth, wrapTextWithAnsi } from '../../rendering/text.js';
import { Input } from '../../widgets/input.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';
import {
  TUI_STATUS_LINE_DEFAULT_ITEMS,
  TUI_STATUS_LINE_ITEMS,
  type TuiStatusLineItem,
} from '../../shell/status-line-items.js';
import { questionnaireFrameContentWidth } from '../interaction/decision-frame.js';
import { statusLineItemDescription, statusLineText } from './status-line-copy.js';

type SelectableItem = Exclude<TuiStatusLineItem, 'build-mode'>;

export interface TuiStatusLinePickerOptions {
  readonly items?: readonly TuiStatusLineItem[];
  readonly preview: (
    items: readonly TuiStatusLineItem[] | undefined,
    width: number,
    height: number,
  ) => {
    lines: string[];
    unavailable: readonly TuiStatusLineItem[];
  };
  readonly save: (items: readonly TuiStatusLineItem[] | undefined) => Promise<void>;
  readonly onClose: () => void;
  readonly requestRender: () => void;
  readonly locale?: string;
}

/** A local draft: preview never applies configuration or executes custom commands. */
export class TuiStatusLinePicker implements Component, Focusable {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private items: SelectableItem[] = [];
  private enabled = new Set<TuiStatusLineItem>();
  private useDefaults: boolean;
  private selected = 0;
  private readonly searchInput = new Input();
  private busy = false;
  private error = false;
  private disposed = false;
  private readonly locked: boolean;

  constructor(private readonly options: TuiStatusLinePickerOptions) {
    this.locked = options.items?.includes('build-mode') ?? false;
    this.useDefaults = options.items === undefined;
    this.resetItems(options.items ?? TUI_STATUS_LINE_DEFAULT_ITEMS);
  }

  get focused(): boolean {
    return this.searchInput.focused;
  }
  set focused(value: boolean) {
    this.searchInput.focused = value && !this.locked;
  }
  private get query(): string {
    return this.searchInput.getValue();
  }

  handleInput(data: string): void {
    if (this.busy || this.disposed) return;
    const keys = getKeybindings();
    if (keys.matches(data, 'tui.select.cancel') || matchesKey(data, 'ctrl+c')) {
      this.options.onClose();
      return;
    }
    if (keys.matches(data, 'tui.select.confirm')) {
      if (this.locked) this.options.onClose();
      else void this.save();
      return;
    }
    if (this.locked) return;
    const visible = this.visibleItems();
    if (keys.matches(data, 'tui.select.up')) {
      this.selected = (this.selected - 1 + visible.length) % Math.max(1, visible.length);
    } else if (keys.matches(data, 'tui.select.down')) {
      this.selected = (this.selected + 1) % Math.max(1, visible.length);
    } else if (matchesKey(data, 'space')) {
      const item = visible[this.selected];
      if (item) {
        if (this.enabled.has(item)) this.enabled.delete(item);
        else this.enabled.add(item);
        this.useDefaults = false;
      }
    } else if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
      if (!this.query) this.moveItem(matchesKey(data, 'left') ? -1 : 1);
      else this.searchInput.handleInput(data);
    } else if (matchesKey(data, 'ctrl+r')) {
      this.resetItems(TUI_STATUS_LINE_DEFAULT_ITEMS);
      this.useDefaults = true;
      this.searchInput.setValue('');
    } else {
      const previous = this.query;
      this.searchInput.handleInput(data);
      if (this.query.length > 100) this.searchInput.setValue(this.query.slice(0, 100));
      if (this.query !== previous) this.selected = 0;
    }
    this.options.requestRender();
  }

  dispose(): void {
    this.disposed = true;
  }
  invalidate(): void {
    this.searchInput.invalidate();
  }
  render(width: number): string[] {
    return this.renderViewport(width, 20);
  }

  renderViewport(width: number, height: number): string[] {
    const rows = Math.max(0, Math.floor(height));
    if (width <= 0 || rows === 0) return [];
    const text = (key: Parameters<typeof statusLineText>[0]) =>
      statusLineText(key, this.options.locale);
    if (this.locked) {
      return renderPanelFrame(
        {
          title: text('title'),
          body: wrapTextWithAnsi(
            text('locked'),
            Math.max(1, questionnaireFrameContentWidth(width)),
          ),
          footer: text('close'),
        },
        width,
        rows,
      );
    }
    const footer = this.busy ? text('saving') : text(width >= 64 ? 'help' : 'compactHelp');
    const layout = panelLayout(width, rows, footer);
    const contentWidth = layout.contentWidth;
    const searchPrompt = `${text('search')}: `;
    const searchLine =
      searchPrompt +
      (this.searchInput.render(Math.max(1, contentWidth - visibleWidth(searchPrompt)))[0] ?? '');
    const visible = this.visibleItems();
    const focused = visible[this.selected];
    const preview = this.options.preview(this.selection(), contentWidth, 3);
    const previewLines = preview.lines
      .filter((line) => line.length > 0)
      .slice(0, rows >= 15 ? 3 : 1);
    if (previewLines.length === 0) previewLines.push(text('empty'));
    const row = (item: SelectableItem) =>
      (item === focused ? chalk.bold.hex(colors.signal) : chalk.hex(colors.text))(
        `${item === focused ? '›' : ' '} [${this.enabled.has(item) ? 'x' : ' '}] ${item}`,
      );
    if (rows < 9) {
      return layout.render({
        title: text('title'),
        body: [
          ...(layout.bodyHeight >= 2 ? [searchLine] : []),
          focused ? row(focused) : text('noMatches'),
          ...(this.error ? [text('failed')] : previewLines),
        ],
      });
    }
    const description = focused
      ? `${statusLineItemDescription(focused, this.options.locale)}${preview.unavailable.includes(focused) ? ` · ${text('unavailable')}` : ''}`
      : text('noMatches');
    const notes =
      rows >= 15
        ? [focused === 'custom-command' ? text('custom') : text(this.query ? 'filtered' : 'reset')]
        : [];
    const extra = this.error ? [chalk.hex(colors.warning)(text('failed'))] : [];
    // Reserve frame, search, description and preview before sizing the list.
    const listRows = Math.max(
      1,
      Math.min(8, layout.bodyHeight - 3 - previewLines.length - notes.length - extra.length),
    );
    const start = Math.max(0, Math.min(this.selected - listRows + 1, visible.length - listRows));
    return layout.render({
      title: text('title'),
      meta: this.useDefaults ? text('defaults') : `${this.enabled.size} / ${this.items.length}`,
      body: [
        searchLine,
        ...(visible.length ? visible.slice(start, start + listRows).map(row) : [text('noMatches')]),
        chalk.hex(colors.muted)(description),
        ...notes.map((note) => chalk.hex(colors.muted)(note)),
        chalk.bold.hex(colors.text)(text('preview')),
        ...previewLines,
        ...extra,
      ],
    });
  }

  private selection(): readonly TuiStatusLineItem[] | undefined {
    return this.useDefaults ? undefined : this.items.filter((item) => this.enabled.has(item));
  }

  private resetItems(selected: readonly TuiStatusLineItem[]): void {
    this.items = [...new Set([...selected, ...TUI_STATUS_LINE_ITEMS])].filter(
      (item): item is SelectableItem => item !== 'build-mode',
    );
    this.enabled = new Set(selected.filter((item) => item !== 'build-mode'));
    this.selected = 0;
  }

  private visibleItems(): SelectableItem[] {
    const query = this.query.toLocaleLowerCase();
    return this.items.filter((item) =>
      `${item} ${statusLineItemDescription(item, this.options.locale)}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }

  private moveItem(delta: -1 | 1): void {
    const target = this.selected + delta;
    const item = this.items[this.selected];
    if (!item || target < 0 || target >= this.items.length) return;
    this.items.splice(this.selected, 1);
    this.items.splice(target, 0, item);
    this.selected = target;
    this.useDefaults = false;
  }

  private async save(): Promise<void> {
    const items = this.selection();
    if (JSON.stringify(items) === JSON.stringify(this.options.items)) {
      this.options.onClose();
      return;
    }
    this.busy = true;
    this.error = false;
    this.options.requestRender();
    try {
      await this.options.save(items);
      if (!this.disposed) this.options.onClose();
    } catch {
      this.error = true;
    } finally {
      this.busy = false;
      if (!this.disposed) this.options.requestRender();
    }
  }
}
