import type { Component } from '../rendering/component.js';
import { truncateToWidth } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { renderTuiActionHint, tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import type { TuiTodoItem, TuiTodoStatus } from '../todo/model.js';
import { formatTuiKeybinding, type TuiKeybindingRegistry } from './keybindings.js';

const COMPACT_TODO_LIMIT = 3;
const COMPACT_ACTION_MIN_COLUMNS = 32;
const CLOSE_ACTION_MIN_COLUMNS = 30;
const FULL_SUMMARY_MIN_COLUMNS = 52;

export class TuiTodoPanel implements Component {
  private items: readonly TuiTodoItem[] = [];
  private expanded = false;

  constructor(private readonly keybindings?: TuiKeybindingRegistry) {}

  setItems(items: readonly TuiTodoItem[]): void {
    const nextItems = items.map((item) => ({ ...item }));
    if (
      nextItems.length === 0 ||
      nextItems.every((item) => item.status === 'completed') ||
      !sharesPlanItem(this.items, nextItems)
    ) {
      this.expanded = false;
    }
    this.items = nextItems;
  }

  toggleExpanded(): 'compact' | 'expanded' {
    if (
      this.items.length === 0 ||
      this.items.every((item) => item.status === 'completed') ||
      (!this.expanded && this.items.length <= COMPACT_TODO_LIMIT)
    ) {
      return 'compact';
    }
    this.expanded = !this.expanded;
    return this.expanded ? 'expanded' : 'compact';
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth < 4 || this.items.length === 0) return [];

    const remaining = this.items.filter((item) => !isSettled(item.status));
    const completed = this.items.filter((item) => item.status === 'completed').length;
    const cancelled = this.items.filter((item) => item.status === 'cancelled').length;
    if (completed === this.items.length) {
      return [
        truncateToWidth(
          `  ${chalk.hex(colors.success)(`✓ Todo list ${completed}/${this.items.length} completed`)}`,
          safeWidth,
          chalk.hex(colors.muted)('…'),
        ),
      ];
    }

    const shortcut = formatTuiKeybinding('composer.toggle-tasks', this.keybindings);
    if (this.expanded) {
      const lines = [
        renderExpandedHeader({
          completed,
          total: this.items.length,
          remaining: remaining.length,
          cancelled,
          shortcut,
          width: safeWidth,
        }),
        ...this.items.map(renderTodoRow),
      ];
      return lines.map((line) => truncateTodoLine(line, safeWidth));
    }

    const { rows, hidden } = selectVisibleTodos(this.items, COMPACT_TODO_LIMIT);
    const pending = this.items.filter((item) => item.status === 'pending').length;
    const lines = [
      ...rows.map(renderTodoRow),
      renderCompactSummary({
        completed,
        total: this.items.length,
        pending,
        cancelled,
        hidden,
        shortcut,
        width: safeWidth,
      }),
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth, chalk.hex(colors.muted)('…')));
  }
}

interface TodoSummary {
  readonly completed: number;
  readonly total: number;
  readonly cancelled: number;
  readonly shortcut: string;
  readonly width: number;
}

function renderExpandedHeader(summary: TodoSummary & { readonly remaining: number }): string {
  const progress = chalk.bold.hex(colors.text)(`Todo list ${summary.completed}/${summary.total}`);
  const action =
    summary.width < CLOSE_ACTION_MIN_COLUMNS
      ? summary.shortcut
      : `${summary.shortcut} ${summary.width < COMPACT_ACTION_MIN_COLUMNS ? 'close' : 'compact'}`;
  if (summary.width < FULL_SUMMARY_MIN_COLUMNS) {
    return `  ${progress}${renderTuiActionHint(` · ${action}`)}`;
  }
  const skipped = summary.cancelled > 0 ? ` · ${summary.cancelled} skipped` : '';
  return `  ${progress}${renderTuiActionHint(
    ` · ${summary.remaining} remaining${skipped} · ${action}`,
  )}`;
}

function renderCompactSummary(
  summary: TodoSummary & { readonly pending: number; readonly hidden: number },
): string {
  if (summary.width < COMPACT_ACTION_MIN_COLUMNS && summary.hidden > 0) {
    return `  ${renderTuiActionHint(`… +${summary.hidden} · ${summary.shortcut} expand`)}`;
  }
  if (summary.width < FULL_SUMMARY_MIN_COLUMNS && summary.hidden > 0) {
    return `  ${renderTuiActionHint(
      `… +${summary.hidden} · ${summary.completed}/${summary.total} · ${summary.shortcut} expand`,
    )}`;
  }
  const hidden = summary.hidden > 0 ? `… +${summary.hidden} more · ` : '';
  const skipped = summary.cancelled > 0 ? ` · ${summary.cancelled} skipped` : '';
  const action = summary.hidden > 0 ? ` · ${summary.shortcut} expand` : '';
  return `  ${renderTuiActionHint(
    `${hidden}${summary.completed}/${summary.total} done${skipped} · ${summary.pending} pending${action}`,
  )}`;
}

function selectVisibleTodos(
  items: readonly TuiTodoItem[],
  limit: number,
): {
  readonly rows: readonly TuiTodoItem[];
  readonly hidden: number;
} {
  if (items.length <= limit) return { rows: items, hidden: 0 };

  const active: number[] = [];
  const pending: number[] = [];
  const settled: number[] = [];
  for (const [index, item] of items.entries()) {
    if (item.status === 'in_progress') active.push(index);
    else if (item.status === 'pending') pending.push(index);
    else settled.push(index);
  }

  const selected = new Set<number>();
  const focus = active[0] ?? pending[0] ?? items.length - 1;
  const recentSettled = settled.filter((index) => index < focus).at(-1) ?? settled.at(-1);
  if (recentSettled !== undefined && limit > 1) selected.add(recentSettled);
  for (const index of active) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  for (const index of pending.filter((candidate) => candidate >= focus)) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  for (const index of pending) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  for (const index of [...settled].reverse()) {
    if (selected.size >= limit) break;
    selected.add(index);
  }

  const indices = [...selected].sort((left, right) => left - right);
  return {
    rows: indices.map((index) => items[index] as TuiTodoItem),
    hidden: items.length - indices.length,
  };
}

function truncateTodoLine(line: string, width: number): string {
  return truncateToWidth(line, width, chalk.hex(colors.muted)('…'));
}

function sharesPlanItem(previous: readonly TuiTodoItem[], next: readonly TuiTodoItem[]): boolean {
  if (previous.length === 0) return false;
  const previousContent = new Set(previous.map((item) => item.content));
  return next.some((item) => previousContent.has(item.content));
}

function renderTodoRow(item: TuiTodoItem): string {
  const content = sanitizeTerminalText(item.content).replace(/\s+/gu, ' ').trim();
  return `  ${renderMarker(item.status)} ${renderContent(content, item.status)}`;
}

function renderMarker(status: TuiTodoStatus): string {
  switch (status) {
    case 'completed':
      return chalk.hex(colors.success)('✓');
    case 'in_progress':
      return chalk.bold.hex(colors.signal)('●');
    case 'cancelled':
      return chalk.hex(colors.muted)('–');
    case 'pending':
      return chalk.hex(colors.dim)('○');
  }
}

function renderContent(content: string, status: TuiTodoStatus): string {
  switch (status) {
    case 'completed':
      return chalk.hex(colors.muted).strikethrough(content);
    case 'in_progress':
      return chalk.bold.hex(colors.text)(content);
    case 'cancelled':
      return chalk.hex(colors.muted).strikethrough(content);
    case 'pending':
      return chalk.hex(colors.text)(content);
  }
}

function isSettled(status: TuiTodoStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}
