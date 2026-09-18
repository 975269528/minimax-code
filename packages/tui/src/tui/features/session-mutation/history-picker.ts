import { panelLayout } from '../../widgets/panel-frame.js';
import { matchesKey } from '../../engine/public.js';
import type { Component, Focusable } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import type { TuiFeatureScreen } from '../../shell/surface-host.js';
import {
  renderTuiActionHint,
  tuiChalk as chalk,
  tuiColors as colors,
  tuiSelectListTheme as theme,
} from '../../theme/runtime.js';
import { SelectList } from '../../widgets/select-list.js';
import type { TuiSessionInputSummary } from '../../../runtime/port.js';
import { sessionMutationTemplate, sessionMutationText } from './copy.js';
import { formatSessionInputSummaryLabel, PROMPT_HEAD_DISPLAY_LIMIT } from './format.js';

export type TuiSessionMutationMode = 'fork' | 'rewind' | 'edit';

export interface TuiSessionMutationHistoryPickerOptions {
  readonly summaries: readonly TuiSessionInputSummary[];
  readonly mode: TuiSessionMutationMode;
  readonly onSelect: (summary: TuiSessionInputSummary) => void;
  readonly onCancel: () => void;
  readonly requestRender?: () => void;
  /** Caller-supplied current time; defaults to Date.now(). */
  readonly nowMs?: number;
}

const MIN_VISIBLE_ROWS = 4;
const MAX_VISIBLE_ROWS = 8;

/**
 * Stable surface-host id for the history picker feature screen. Exposed so
 * the session-mutation flow can identify and re-open the picker without
 * duplicating the string literal.
 */
export const TUI_SESSION_MUTATION_HISTORY_PICKER_SCREEN_ID = 'session-mutation:history';

export class TuiSessionMutationHistoryPicker implements TuiFeatureScreen, Component, Focusable {
  readonly id = TUI_SESSION_MUTATION_HISTORY_PICKER_SCREEN_ID;
  readonly layoutRoot: Component = this;
  readonly handlesViewportKeys = true;
  private readonly summaries: readonly TuiSessionInputSummary[];
  private readonly hiddenIncompleteCount: number;
  private readonly list: SelectList | undefined;
  private readonly nowMs: () => number;
  private _focused = false;
  private cancelInvoked = false;
  private selectInvoked = false;
  private busy = false;
  private error?: string;

  constructor(private readonly options: TuiSessionMutationHistoryPickerOptions) {
    this.summaries = [...options.summaries]
      .filter((summary) => options.mode !== 'fork' || Boolean(summary.assistantMessageId))
      .reverse();
    this.hiddenIncompleteCount = options.summaries.length - this.summaries.length;
    this.nowMs = () => options.nowMs ?? Date.now();
    if (this.summaries.length === 0) {
      this.list = undefined;
      return;
    }
    this.list = new SelectList(
      this.summaries.map((summary, index) => ({
        value: `${String(index)}:${summary.userMessageId}`,
        label: formatSessionInputSummaryLabel(summary, {
          nowMs: this.nowMs(),
          promptMaxWidth: PROMPT_HEAD_DISPLAY_LIMIT,
          ...(options.mode !== 'fork' ? { affectedTurnCount: index + 1 } : {}),
        }).title,
        description: formatSessionInputSummaryLabel(summary, {
          nowMs: this.nowMs(),
          promptMaxWidth: PROMPT_HEAD_DISPLAY_LIMIT,
          ...(options.mode !== 'fork' ? { affectedTurnCount: index + 1 } : {}),
        }).subtitle,
      })),
      Math.min(this.summaries.length, MAX_VISIBLE_ROWS),
      theme,
      {
        minPrimaryColumnWidth: 20,
        maxPrimaryColumnWidth: 40,
        truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, '\u2026'),
      },
    );
    this.list.setSelectedIndex(0);
    this.list.onSelect = (item) => this.handleSelect(item.value);
    this.list.onCancel = () => this.handleCancel();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (this.busy) {
      if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) this.handleCancel();
      return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.handleCancel();
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const current = this.list?.getSelectedItem();
      if (current) this.handleSelect(current.value);
      return;
    }
    this.list?.handleInput(data);
  }

  invalidate(): void {
    this.list?.invalidate();
  }

  render(width: number): string[] {
    return this.renderViewport(width, 24);
  }

  renderViewport(width: number, height: number): string[] {
    const layout = panelLayout(width, height, this.renderFooter(Number.MAX_SAFE_INTEGER));
    const header =
      layout.bodyHeight >= 5
        ? [
            chalk.hex(colors.muted)(
              sessionMutationText(`sessionMutation.history.${this.options.mode}.helper`),
            ),
          ]
        : [];
    const error = this.error ? [chalk.hex(colors.warning)(sanitizeTerminalText(this.error))] : [];
    const body = this.list
      ? this.list.renderViewport(
          layout.contentWidth,
          Math.max(1, layout.bodyHeight - header.length - error.length),
        )
      : this.renderEmpty(layout.contentWidth);
    const content = [...header, ...body, ...error];
    if (Number.isFinite(layout.bodyHeight))
      while (content.length < layout.bodyHeight) content.push('');
    return layout.render({
      title: sessionMutationText(`sessionMutation.history.${this.options.mode}.title`),
      body: content,
    });
  }

  /** Re-enable selection after a failed options request while keeping the picker mounted. */
  resetSelection(error?: string): void {
    this.selectInvoked = false;
    this.busy = false;
    this.error = error;
    if (this.list) this.list.setSelectedIndex(0);
    this.invalidate();
    this.options.requestRender?.();
  }

  private renderEmpty(width: number): string[] {
    const text = sessionMutationText('sessionMutation.history.empty');
    return [chalk.hex(colors.muted)(fit(sanitizeTerminalText(text), width))];
  }

  private renderFooter(width: number): string[] {
    if (this.busy) {
      const label =
        this.options.mode === 'fork'
          ? 'Checking fork details…'
          : this.options.mode === 'edit'
            ? 'Loading the selected message…'
            : 'Loading rewind impact…';
      return [
        fit(
          `${chalk.hex(colors.signal)(`⠋ ${label}`)}${chalk.hex(colors.dim)(' · ')}${renderTuiActionHint('Esc cancel')}`,
          width,
        ),
      ];
    }
    const hint = sessionMutationText(`sessionMutation.history.${this.options.mode}.hint`);
    const rows = [renderTuiActionHint(fit(sanitizeTerminalText(hint), width))];
    if (this.hiddenIncompleteCount > 0) {
      rows.unshift(
        chalk.hex(colors.muted)(
          fit(
            sanitizeTerminalText(
              this.hiddenIncompleteCount === 1
                ? sessionMutationText('sessionMutation.history.incomplete.one')
                : sessionMutationTemplate('sessionMutation.history.incomplete.many', {
                    count: this.hiddenIncompleteCount,
                  }),
            ),
            width,
          ),
        ),
      );
    }
    return rows;
  }

  private handleSelect(rawValue: string): void {
    if (this.selectInvoked || this.cancelInvoked) return;
    const summary = this.resolveSummary(rawValue);
    if (!summary) return;
    this.selectInvoked = true;
    this.busy = true;
    this.error = undefined;
    this.options.requestRender?.();
    this.options.onSelect(summary);
  }

  private handleCancel(): void {
    if (this.cancelInvoked) return;
    this.cancelInvoked = true;
    this.options.onCancel();
  }

  private resolveSummary(value: string): TuiSessionInputSummary | undefined {
    // Value is encoded as `<index>:<userMessageId>` so the picker can survive
    // duplicate heads without losing the original summary identity.
    const colonAt = value.indexOf(':');
    if (colonAt < 0) return undefined;
    const index = Number.parseInt(value.slice(0, colonAt), 10);
    const id = value.slice(colonAt + 1);
    if (!Number.isFinite(index) || index < 0 || index >= this.summaries.length) return undefined;
    const summary = this.summaries[index];
    if (!summary || summary.userMessageId !== id) return undefined;
    return summary;
  }
}

function fit(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  return truncateToWidth(value, width, chalk.hex(colors.dim)('\u2026'));
}

/** Re-export of the canonical minimum visible rows for the picker. */
export const TUI_SESSION_MUTATION_PICKER_MIN_VISIBLE = MIN_VISIBLE_ROWS;
