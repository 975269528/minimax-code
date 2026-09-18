import { panelLayout } from '../../widgets/panel-frame.js';
import { Key, matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
} from '../../theme/runtime.js';
import { Input } from '../../widgets/input.js';
import type { TuiSessionInputSummary } from '../../../runtime/port.js';
import { sessionHistoryText, sessionMutationTemplate, sessionMutationText } from './copy.js';
import { formatPromptHead, formatRelativeTimestamp, summarizeFileChangeCount } from './format.js';

export type TuiSessionHistoryAction =
  | 'fork'
  | 'edit'
  | 'rewind-conversation'
  | 'rewind-conversation-and-files';

export interface TuiSessionHistoryExplorerOptions {
  readonly sessionTitle?: string;
  readonly summaries: readonly TuiSessionInputSummary[];
  readonly mutationAvailable: boolean;
  readonly mutationUnavailableReason?: string;
  readonly onAction: (
    action: TuiSessionHistoryAction,
    summary: TuiSessionInputSummary,
    affectedTurnCount: number,
  ) => void;
  readonly onCancel: () => void;
  readonly onRetryLoad?: () => void;
  readonly requestRender: () => void;
  readonly nowMs?: number;
  readonly loading?: boolean;
}

interface HistoryActionItem {
  readonly action: TuiSessionHistoryAction;
  readonly label: string;
  readonly description: string;
  readonly disabledReason?: string;
}

const MAX_VISIBLE_HISTORY_ROWS = 8;

export class TuiSessionHistoryExplorer implements TuiFeatureScreen, Component, Focusable {
  readonly id = 'session-history:explorer';
  readonly layoutRoot: Component = this;
  readonly handlesViewportKeys = true;
  private readonly searchInput = new Input();
  private summaries: readonly TuiSessionInputSummary[];
  private readonly nowMs: () => number;
  private selectedIndex = 0;
  private visibleEntryCount = MAX_VISIBLE_HISTORY_ROWS;
  private selectedMessageId?: string;
  private actionIndex = 0;
  private mode: 'list' | 'actions' = 'list';
  private busy = false;
  private busyLabel?: string;
  private loading: boolean;
  private loadError?: string;
  private error?: string;
  private _focused = false;
  private closed = false;

  constructor(private readonly options: TuiSessionHistoryExplorerOptions) {
    this.summaries = [...options.summaries].sort((left, right) => right.timestamp - left.timestamp);
    this.nowMs = () => options.nowMs ?? Date.now();
    this.loading = options.loading ?? false;
    this.searchInput.onSubmit = () => this.openActions();
    this.clampSelection();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.mode === 'list' && !this.busy;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.loading) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.close();
      return;
    }
    if (this.loadError) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
        this.close();
        return;
      }
      if (matchesKey(data, 'enter')) {
        this.loading = true;
        this.loadError = undefined;
        this.options.requestRender();
        this.options.onRetryLoad?.();
      }
      return;
    }
    if (this.busy) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.close();
      return;
    }
    if (this.mode === 'actions') {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
        this.mode = 'list';
        this.error = undefined;
        this.syncFocus();
        this.options.requestRender();
        return;
      }
      if (matchesKey(data, 'up')) return this.moveAction(-1);
      if (matchesKey(data, 'down')) return this.moveAction(1);
      if (matchesKey(data, 'enter') || matchesKey(data, 'space')) this.chooseAction();
      return;
    }

    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      if (this.searchInput.getValue()) {
        this.searchInput.setValue('');
        this.resetSelection();
      } else this.close();
      return;
    }
    if (matchesKey(data, 'up')) return this.moveSelection(-1);
    if (matchesKey(data, 'down')) return this.moveSelection(1);
    if (matchesKey(data, Key.pageUp)) return this.moveSelection(-this.visibleEntryCount);
    if (matchesKey(data, Key.pageDown)) return this.moveSelection(this.visibleEntryCount);
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      this.openActions();
      return;
    }
    const previous = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (previous !== this.searchInput.getValue()) this.resetSelection();
    else this.options.requestRender();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  render(width: number): string[] {
    return this.renderViewport(width, 24);
  }

  renderViewport(rawWidth: number, rawHeight: number): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    const height = Math.max(1, Math.floor(rawHeight));
    if (width === 0) return [];
    const footer = this.busy
      ? renderBusyFooter(this.busyLabel ?? sessionHistoryText('preparingRewind'))
      : sessionHistoryText(
          this.loading
            ? 'loadingHint'
            : this.loadError
              ? 'loadErrorHint'
              : this.mode === 'actions'
                ? 'actionsHint'
                : height < 10
                  ? 'compactHint'
                  : this.searchInput.getValue()
                    ? 'filterHint'
                    : 'hint',
        );
    const layout = panelLayout(width, height, footer);
    const contentWidth = layout.contentWidth;
    const contentHeight = layout.bodyHeight;
    const body = this.loading
      ? [chalk.hex(colors.signal)(`⠋ ${sessionHistoryText('loading')}`)]
      : this.loadError
        ? [chalk.hex(colors.warning)(sanitizeTerminalText(this.loadError))]
        : this.mode === 'actions'
          ? this.renderActions(contentWidth, contentHeight)
          : this.renderList(contentWidth, contentHeight);
    const lines = layout.render({
      title: this.mode === 'actions' ? sessionHistoryText('actions') : sessionHistoryText('title'),
      meta: this.options.sessionTitle?.trim()
        ? formatPromptHead(sanitizeTerminalText(this.options.sessionTitle), Math.floor(width / 2))
        : undefined,
      body,
    });
    const fitted = lines.map((line) => fitLine(line, width));
    if (fitted.length >= height) return fitted.slice(0, height);
    while (fitted.length < height) fitted.push('');
    return fitted;
  }

  setBusy(value: boolean, label?: string): void {
    this.busy = value;
    this.busyLabel = value ? label : undefined;
    if (value) this.error = undefined;
    this.syncFocus();
    this.options.requestRender();
  }

  restoreAfterAction(error?: string): void {
    this.busy = false;
    this.busyLabel = undefined;
    this.mode = 'list';
    this.error = error;
    this.syncFocus();
    this.options.requestRender();
  }

  setSummaries(summaries: readonly TuiSessionInputSummary[]): void {
    this.summaries = [...summaries].sort((left, right) => right.timestamp - left.timestamp);
    this.loading = false;
    this.loadError = undefined;
    this.resetSelection();
  }

  setLoadError(error: string): void {
    this.loading = false;
    this.loadError = error;
    this.options.requestRender();
  }

  private renderList(width: number, height: number): string[] {
    const visible = this.visibleSummaries();
    this.clampSelection(visible);
    const searchLabel = `${sessionHistoryText('search')}: `;
    const search = this.searchInput.render(Math.max(1, width - visibleWidth(searchLabel)))[0] ?? '';
    const lines: string[] =
      height >= 2
        ? [`${chalk.hex(colors.muted)(searchLabel)}${search}`, ...(height >= 5 ? [''] : [])]
        : [];
    const availableRows = Math.max(1, height - lines.length - (this.error ? 1 : 0));
    if (visible.length === 0) {
      lines.push(
        chalk.hex(colors.muted)(
          this.searchInput.getValue().trim()
            ? sessionHistoryText('noResults')
            : sessionMutationText('sessionMutation.history.empty'),
        ),
      );
    } else {
      // Keep each prompt and its metadata together; never repeat the selected prompt below the list.
      const entryRows = availableRows >= 2 ? 2 : 1;
      const gapRows = availableRows >= 10 ? 1 : 0;
      this.visibleEntryCount = Math.max(
        1,
        Math.min(
          MAX_VISIBLE_HISTORY_ROWS,
          Math.floor((availableRows + gapRows) / (entryRows + gapRows)),
        ),
      );
      const start = Math.max(
        0,
        Math.min(
          this.selectedIndex - Math.floor(this.visibleEntryCount / 2),
          visible.length - this.visibleEntryCount,
        ),
      );
      const end = Math.min(visible.length, start + this.visibleEntryCount);
      for (let index = start; index < end; index += 1) {
        const summary = visible[index];
        if (!summary) continue;
        const selected = summary.userMessageId === this.selectedMessageId;
        const title = formatPromptHead(sanitizeTerminalText(summary.contentHead ?? ''), width - 2);
        lines.push(
          (selected ? chalk.bold.hex(colors.signal) : chalk.hex(colors.text))(
            `${selected ? '›' : ' '} ${title}`,
          ),
        );
        if (entryRows > 1) {
          const metadata = [
            formatRelativeTimestamp(summary.timestamp, this.nowMs()),
            summarizeFileChangeCount(summary.fileChangeCount),
            ...(!summary.assistantMessageId ? [sessionHistoryText('incomplete')] : []),
          ];
          lines.push(chalk.hex(colors.muted)(`  ${metadata.join(' · ')}`));
        }
        if (gapRows && index < end - 1) lines.push('');
      }
    }
    if (this.error) lines.push(chalk.hex(colors.warning)(sanitizeTerminalText(this.error)));
    return lines;
  }

  private renderActions(width: number, height: number): string[] {
    const summary = this.selectedSummary();
    if (!summary)
      return [chalk.hex(colors.muted)(sessionMutationText('sessionMutation.history.empty'))];
    const actions = this.actions(summary);
    const affected = this.affectedTurnCount(summary);
    const context = [
      summarizeFileChangeCount(summary.fileChangeCount),
      sessionMutationTemplate(
        affected === 1
          ? 'sessionMutation.format.affected.one'
          : 'sessionMutation.format.affected.many',
        { count: affected },
      ),
      formatRelativeTimestamp(summary.timestamp, this.nowMs()),
    ].join(' · ');
    const header = [
      chalk.hex(colors.muted)(formatPromptHead(summary.contentHead, Math.max(16, width - 2))),
      chalk.hex(colors.muted)(context),
    ].slice(0, Math.max(0, height - 2));
    const body = actions.flatMap((action, index) => {
      const selected = index === this.actionIndex;
      const prefix = selected ? chalk.bold.hex(colors.signal)('› ') : '  ';
      const label = action.disabledReason
        ? chalk.hex(colors.dim)(action.label)
        : selected
          ? chalk.bold.hex(colors.signal)(action.label)
          : chalk.hex(colors.text)(action.label);
      return [
        `${prefix}${label}`,
        chalk.hex(action.disabledReason ? colors.warning : colors.muted)(
          `  ${action.disabledReason ?? action.description}`,
        ),
      ];
    });
    if (this.error) body.push('', chalk.hex(colors.warning)(sanitizeTerminalText(this.error)));
    const bodyBudget = Math.max(0, height - header.length);
    const selectedLine = this.actionIndex * 2;
    const start = Math.max(0, Math.min(selectedLine, Math.max(0, body.length - bodyBudget)));
    return [...header, ...body.slice(start, start + bodyBudget)];
  }

  private visibleSummaries(): TuiSessionInputSummary[] {
    const tokens = this.searchInput
      .getValue()
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/u)
      .filter(Boolean);
    if (tokens.length === 0) return [...this.summaries];
    return this.summaries.filter((summary) =>
      tokens.every((token) => matchesHistoryToken(summary, token, this.nowMs())),
    );
  }

  private affectedTurnCount(summary: TuiSessionInputSummary): number {
    const index = this.summaries.findIndex(
      (candidate) => candidate.userMessageId === summary.userMessageId,
    );
    return index >= 0 ? index + 1 : 1;
  }

  private moveSelection(delta: number): void {
    const visible = this.visibleSummaries();
    if (visible.length === 0) return;
    this.clampSelection(visible);
    this.selectedIndex = Math.max(0, Math.min(visible.length - 1, this.selectedIndex + delta));
    this.selectedMessageId = visible[this.selectedIndex]?.userMessageId;
    this.error = undefined;
    this.options.requestRender();
  }

  private resetSelection(): void {
    this.selectedIndex = 0;
    this.selectedMessageId = this.visibleSummaries()[0]?.userMessageId;
    this.error = undefined;
    this.options.requestRender();
  }

  private clampSelection(visible = this.visibleSummaries()): void {
    if (visible.length === 0) {
      this.selectedIndex = 0;
      this.selectedMessageId = undefined;
      return;
    }
    const anchored = this.selectedMessageId
      ? visible.findIndex((summary) => summary.userMessageId === this.selectedMessageId)
      : -1;
    this.selectedIndex =
      anchored >= 0 ? anchored : Math.max(0, Math.min(this.selectedIndex, visible.length - 1));
    this.selectedMessageId = visible[this.selectedIndex]?.userMessageId;
  }

  private selectedSummary(visible = this.visibleSummaries()): TuiSessionInputSummary | undefined {
    if (this.selectedMessageId) {
      const selected = visible.find((summary) => summary.userMessageId === this.selectedMessageId);
      if (selected) return selected;
    }
    return visible[this.selectedIndex];
  }

  private openActions(): void {
    if (!this.selectedSummary()) return;
    this.mode = 'actions';
    this.actionIndex = 0;
    this.error = undefined;
    this.syncFocus();
    this.options.requestRender();
  }

  private moveAction(delta: number): void {
    const summary = this.selectedSummary();
    if (!summary) return;
    const actions = this.actions(summary);
    this.actionIndex = (this.actionIndex + delta + actions.length) % Math.max(1, actions.length);
    this.error = undefined;
    this.options.requestRender();
  }

  private chooseAction(): void {
    const summary = this.selectedSummary();
    if (!summary) return;
    const action = this.actions(summary)[this.actionIndex];
    if (!action) return;
    if (action.disabledReason) {
      this.error = action.disabledReason;
      this.options.requestRender();
      return;
    }
    this.busy = true;
    this.busyLabel = this.preparingLabel(action.action);
    this.error = undefined;
    this.syncFocus();
    this.options.requestRender();
    this.options.onAction(action.action, summary, this.affectedTurnCount(summary));
  }

  private preparingLabel(action: TuiSessionHistoryAction): string {
    if (action === 'fork') return sessionHistoryText('preparingFork');
    if (action === 'edit') return sessionHistoryText('preparingEdit');
    return sessionHistoryText('preparingRewind');
  }

  private actions(summary: TuiSessionInputSummary): readonly HistoryActionItem[] {
    const mutationDisabled = this.options.mutationAvailable
      ? undefined
      : (this.options.mutationUnavailableReason ?? sessionHistoryText('mutationUnavailable'));
    const forkDisabled =
      mutationDisabled ??
      (!summary.assistantMessageId ? sessionHistoryText('forkUnavailable') : undefined);
    return [
      {
        action: 'fork',
        label: sessionHistoryText('fork'),
        description: sessionHistoryText('forkDescription'),
        ...(forkDisabled ? { disabledReason: forkDisabled } : {}),
      },
      {
        action: 'edit',
        label: sessionHistoryText('edit'),
        description: sessionHistoryText('editDescription'),
        ...(mutationDisabled ? { disabledReason: mutationDisabled } : {}),
      },
      {
        action: 'rewind-conversation',
        label: sessionHistoryText('rewindConversation'),
        description: sessionHistoryText('rewindConversationDescription'),
        ...(mutationDisabled ? { disabledReason: mutationDisabled } : {}),
      },
      {
        action: 'rewind-conversation-and-files',
        label: sessionHistoryText('rewindFiles'),
        description: sessionHistoryText('rewindFilesDescription'),
        ...(mutationDisabled ? { disabledReason: mutationDisabled } : {}),
      },
    ];
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.searchInput.focused = false;
    this.options.onCancel();
  }

  private syncFocus(): void {
    this.searchInput.focused = this._focused && this.mode === 'list' && !this.busy;
  }
}

function matchesHistoryToken(
  summary: TuiSessionInputSummary,
  token: string,
  nowMs: number,
): boolean {
  if (token === 'forkable') return Boolean(summary.assistantMessageId);
  if (token.startsWith('files:')) {
    const count = Number.parseInt(token.slice('files:'.length), 10);
    return Number.isFinite(count) && summary.fileChangeCount === count;
  }
  const searchable = [
    summary.contentHead,
    formatRelativeTimestamp(summary.timestamp, nowMs),
    summary.assistantMessageId ? 'forkable assistant replied' : '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
  return searchable.includes(token);
}

function fitLine(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  return truncateToWidth(value, width, chalk.hex(colors.dim)('…'));
}

function renderBusyFooter(label: string): string {
  return `${chalk.hex(colors.signal)(`⠋ ${label}`)}${chalk.hex(colors.dim)(' · ')}${renderTuiActionHint('Esc cancel')}`;
}
