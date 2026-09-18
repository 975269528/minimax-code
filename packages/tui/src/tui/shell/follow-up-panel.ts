import type { Component } from '../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../rendering/text.js';
import { renderTuiActionHint, tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { formatTuiKeybinding, type TuiKeybindingRegistry } from './keybindings.js';

const MAX_VISIBLE_WAITING_ITEMS = 4;

export interface TuiFollowUpPanelItem {
  itemId: string;
  status: string;
  content: string;
  attachmentNames: readonly string[];
  failedReason?: string;
}

export interface TuiFollowUpPanelOptions {
  readonly keybindings?: TuiKeybindingRegistry;
}

export class TuiFollowUpPanel implements Component {
  private items: readonly TuiFollowUpPanelItem[] = [];
  private summary = { paused: false, pendingCount: 0 };

  constructor(private readonly options: TuiFollowUpPanelOptions = {}) {}

  setItems(items: readonly TuiFollowUpPanelItem[]): void {
    this.items = items;
  }

  setQueueSummary(summary: { readonly paused: boolean; readonly pendingCount: number }): void {
    this.summary = summary;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth < 4) return [];

    const failed = this.items.find((item) => item.status === 'failed');
    const waiting = this.items.filter(
      (item) => item.status === 'queued' || item.status === 'paused',
    );
    if (!failed && waiting.length === 0 && !this.summary.paused) return [];

    return [
      ...(failed ? renderFailedItem(failed, safeWidth) : []),
      ...(this.summary.paused
        ? [
            truncateToWidth(
              chalk.hex(colors.warning)(
                `Queue paused · ${this.summary.pendingCount} pending · /queue to continue`,
              ),
              safeWidth,
            ),
          ]
        : []),
      ...renderWaitingItems(waiting, safeWidth, this.options.keybindings, this.summary.paused),
    ];
  }
}

function renderFailedItem(item: TuiFollowUpPanelItem, width: number): string[] {
  const reason = sanitizeTerminalText(item.failedReason ?? '').trim();
  const title = `Couldn't send${reason ? ` · ${reason}` : ''}`;
  return [
    truncateToWidth(
      `${chalk.bold.hex(colors.error)('×')} ${chalk.bold.hex(colors.error)(title)}`,
      width,
      chalk.hex(colors.muted)('…'),
    ),
    renderItemLine(item, chalk.hex(colors.line)('└'), '', width),
  ];
}

function renderWaitingItems(
  items: readonly TuiFollowUpPanelItem[],
  width: number,
  keybindings: TuiKeybindingRegistry | undefined,
  paused = false,
): string[] {
  if (items.length === 0) return [];
  const manage = '/queue manage';
  const sendTiming = paused ? 'paused' : 'after current response';
  const restore = `${formatTuiKeybinding('run.restore-waiting-option', keybindings)} restore latest`;
  if (items.length === 1 && items[0]) {
    return [
      ...renderWaitingHeader('Next', sendTiming, restore, manage, width),
      renderItemLine(items[0], chalk.hex(colors.line)('└'), '', width),
    ];
  }
  const visible = items.slice(0, MAX_VISIBLE_WAITING_ITEMS);
  const hiddenCount = items.length - visible.length;
  const header = renderWaitingHeader(
    `Queue · ${items.length} next`,
    sendTiming,
    restore,
    manage,
    width,
  );
  const rows = visible.map((item, index) =>
    renderItemLine(
      item,
      chalk.hex(colors.line)(index === visible.length - 1 && hiddenCount === 0 ? '└' : '│'),
      `${index + 1}. `,
      width,
    ),
  );
  if (hiddenCount > 0) {
    rows.push(
      truncateToWidth(
        `${chalk.hex(colors.line)('└')}  ${chalk.hex(colors.muted)(`+${hiddenCount} more`)}`,
        width,
        chalk.hex(colors.muted)('…'),
      ),
    );
  }
  return [...header, ...rows];
}

function renderWaitingHeader(
  title: string,
  sendTiming: string,
  restore: string,
  manage: string,
  width: number,
): string[] {
  const status = `${chalk.bold.hex(colors.signal)('○')} ${chalk.bold.hex(colors.signal)(
    title,
  )}${chalk.hex(colors.dim)(' · ')}${chalk.hex(colors.muted)(sendTiming)}`;
  const actionText = [restore, manage].join(' · ');
  const actions = `${chalk.hex(colors.dim)(' · ')}${renderTuiActionHint(actionText)}`;
  if (visibleWidth(status) + visibleWidth(actions) <= width) return [`${status}${actions}`];
  if (visibleWidth(actionText) + 2 <= width) {
    return [
      truncateToWidth(status, width, chalk.hex(colors.muted)('…')),
      `  ${renderTuiActionHint(actionText)}`,
    ];
  }
  return [
    truncateToWidth(status, width, chalk.hex(colors.muted)('…')),
    truncateToWidth(`  ${renderTuiActionHint(restore)}`, width, chalk.hex(colors.muted)('…')),
    truncateToWidth(`  ${renderTuiActionHint(manage)}`, width, chalk.hex(colors.muted)('…')),
  ];
}

function itemPreview(item: TuiFollowUpPanelItem): string {
  const content = sanitizeTerminalText(item.content).replace(/\s+/gu, ' ').trim();
  const attachments = item.attachmentNames
    .map((name) => sanitizeTerminalText(name).replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
  const attachmentSuffix = attachments.length > 0 ? ` · ${attachments.join(', ')}` : '';
  return `${content || '(attachment-only message)'}${attachmentSuffix}`;
}

function renderItemLine(
  item: TuiFollowUpPanelItem,
  branch: string,
  index: string,
  width: number,
): string {
  return truncateToWidth(
    `${branch}  ${chalk.hex(colors.text)(`${index}${itemPreview(item)}`)}`,
    width,
    chalk.hex(colors.muted)('…'),
  );
}
