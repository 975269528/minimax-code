import type { Component } from '../rendering/component.js';
import { truncateToWidth, visibleWidth } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import {
  capacityBarWidth,
  remainingCapacityTone,
  renderCapacityBar,
  usedCapacityTone,
} from './capacity-meter.js';
import type {
  TranscriptInspectionTone,
  TranscriptUsageAccountRow,
  TranscriptUsageVisualization,
} from './model.js';

const MAX_CONTENT_WIDTH = 128;
const MIN_HERO_BAR_WIDTH = 24;
const MAX_HERO_BAR_WIDTH = 56;
const MIN_ACCOUNT_BAR_WIDTH = 16;
const MAX_ACCOUNT_BAR_WIDTH = 40;
const INLINE_METRICS_MIN_WIDTH = 48;

/** Product-owned, width-safe visualization for session and account usage. */
export class UsageVisualization implements Component {
  constructor(private readonly data: TranscriptUsageVisualization) {}

  invalidate(): void {}

  render(rawWidth: number): string[] {
    const width = Math.min(MAX_CONTENT_WIDTH, Math.max(0, Math.floor(rawWidth)));
    if (width === 0) return [];
    if (width < 8) return [truncateToWidth('Usage', width, '…')];

    const lines = [this.header(width), chalk.hex(colors.dim)(safeInline(this.data.model)), ''];
    lines.push(...this.sessionSummary(width));
    if (this.data.cacheMetrics) {
      lines.push('', ...renderCacheSummary(this.data.cacheMetrics, width));
    }
    lines.push('', ...renderContextSummary(this.data.context, width));
    if (this.data.accountRows && this.data.accountRows.length > 0) {
      lines.push('', ...renderAccountSummary(this.data.accountRows, width));
    }
    return lines.map((line) => truncateToWidth(line, width, chalk.hex(colors.dim)('…')));
  }

  private header(width: number): string {
    const title = chalk.bold.hex(colors.text)('Usage');
    const summary =
      this.data.sessionRecorded === false
        ? chalk.hex(colors.dim)('Account only')
        : chalk.bold.hex(colors.signal)(`${formatCompact(this.data.totalTokens)} total`);
    return composeEdges(title, summary, width);
  }

  private sessionSummary(width: number): string[] {
    const heading = sectionHeading('This session');
    if (this.data.sessionRecorded === false) {
      return [heading, chalk.hex(colors.dim)('No token activity yet.')];
    }

    const metrics = [
      metric('Input', formatCompact(this.data.inputTokens)),
      metric('Output', formatCompact(this.data.outputTokens)),
      metric('Total', formatCompact(this.data.totalTokens)),
    ];
    if (width >= INLINE_METRICS_MIN_WIDTH) return [heading, metrics.join('     ')];
    if (width >= 26) return [heading, metrics.slice(0, 2).join('   '), metrics[2] ?? ''];
    return [heading, ...metrics];
  }
}

function renderCacheSummary(
  cache: NonNullable<TranscriptUsageVisualization['cacheMetrics']>,
  width: number,
): string[] {
  const ratio = clampRatio(cache.cacheReadRatio);
  const heading = composeEdges(
    sectionHeading('Cache'),
    chalk.bold.hex(colors.signal)(`Read ${Math.round(ratio * 100)}%`),
    width,
  );
  const metrics = [
    metric('Read', formatCompact(cache.cacheReadTokens)),
    metric('Fresh', formatCompact(cache.freshInputTokens)),
    metric('Write', formatCompact(cache.cacheWriteTokens)),
  ];
  if (width >= INLINE_METRICS_MIN_WIDTH) return [heading, metrics.join('     ')];
  if (width >= 26) return [heading, metrics.slice(0, 2).join('   '), metrics[2] ?? ''];
  return [heading, ...metrics];
}

function renderContextSummary(
  context: TranscriptUsageVisualization['context'],
  width: number,
): string[] {
  if (!context || !Number.isFinite(context.windowTokens) || context.windowTokens <= 0) {
    return [sectionHeading('Context'), chalk.hex(colors.dim)('Waiting for a context snapshot.')];
  }

  const utilization = clampRatio(context.utilization);
  const health = contextHealth(utilization);
  const heading = composeEdges(
    sectionHeading('Context'),
    chalk.bold.hex(health.color)(health.label),
    width,
  );
  const barWidth = resolveBarWidth(width, MIN_HERO_BAR_WIDTH, MAX_HERO_BAR_WIDTH, 46);
  const bar = renderCapacityBar(utilization, {
    width: barWidth,
    tone: usedCapacityTone(utilization),
  });
  const usedPercent = Math.round(utilization * 100);
  const capacity = `${usedPercent}% used · ${100 - usedPercent}% free`;
  const tokens = `${formatCompact(context.usedTokens)} / ${formatCompact(context.windowTokens)}`;
  const detail = `${capacity} · ${tokens}`;
  if (capacityBarWidth(barWidth) + 3 + visibleWidth(detail) <= width) {
    return [heading, `${bar}   ${chalk.hex(colors.text)(detail)}`];
  }
  return [heading, bar, chalk.hex(colors.text)(capacity), chalk.hex(colors.dim)(tokens)];
}

function renderAccountSummary(
  accountRows: readonly TranscriptUsageAccountRow[],
  width: number,
): string[] {
  return [
    sectionHeading('Account'),
    ...accountRows.flatMap((item) => renderAccountRow(item, width)),
  ];
}

function renderAccountRow(item: TranscriptUsageAccountRow, width: number): string[] {
  const label = chalk.hex(colors.muted)(safeInline(item.label));
  const detail = paintTone(safeInline(item.value), item.tone ?? 'neutral');
  if (item.remainingRatio === undefined || !Number.isFinite(item.remainingRatio)) {
    return visibleWidth(label) + 2 + visibleWidth(detail) <= width
      ? [composeEdges(label, detail, width)]
      : [label, detail];
  }

  const ratio = clampRatio(item.remainingRatio);
  const barWidth = resolveBarWidth(width, MIN_ACCOUNT_BAR_WIDTH, MAX_ACCOUNT_BAR_WIDTH, 42);
  const bar = renderCapacityBar(ratio, {
    width: barWidth,
    tone: remainingCapacityTone(ratio),
  });
  const lead = `${label}  ${bar}`;
  return visibleWidth(lead) + 2 + visibleWidth(detail) <= width
    ? [composeEdges(lead, detail, width)]
    : [composeEdges(label, detail, width), bar];
}

function metric(label: string, value: string): string {
  return `${chalk.hex(colors.dim)(label)} ${chalk.bold.hex(colors.text)(value)}`;
}

function sectionHeading(value: string): string {
  return chalk.bold.hex(colors.muted)(value);
}

function composeEdges(left: string, right: string, width: number): string {
  const fittedLeft = truncateToWidth(left, width, '…');
  const remaining = Math.max(0, width - visibleWidth(fittedLeft));
  if (remaining === 0) return fittedLeft;
  const fittedRight = truncateToWidth(right, Math.max(1, remaining - 1), '…');
  const gap = Math.max(1, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
  return `${fittedLeft}${' '.repeat(gap)}${fittedRight}`;
}

function contextHealth(utilization: number): { label: string; color: string } {
  if (utilization >= 0.95) return { label: 'Nearly full', color: colors.error };
  if (utilization >= 0.85) return { label: 'Running low', color: colors.error };
  if (utilization >= 0.7) return { label: 'Keep an eye on it', color: colors.warning };
  if (utilization >= 0.45) return { label: 'Comfortable', color: colors.signal };
  return { label: 'Plenty of room', color: colors.success };
}

function paintTone(value: string, tone: TranscriptInspectionTone): string {
  const color =
    tone === 'accent'
      ? colors.signal
      : tone === 'success'
        ? colors.success
        : tone === 'warning'
          ? colors.warning
          : tone === 'error'
            ? colors.error
            : colors.text;
  return chalk.hex(color)(value);
}

function formatCompact(value: number): string {
  const amount = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (amount < 1_000) return String(Math.floor(amount));
  if (amount >= 1_000_000) return `${formatDecimal(amount / 1_000_000)}m`;
  return `${formatDecimal(amount / 1_000)}k`;
}

function formatDecimal(value: number): string {
  return value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function resolveBarWidth(
  width: number,
  minimum: number,
  maximum: number,
  reserved: number,
): number {
  return Math.min(maximum, Math.max(minimum, width - reserved));
}

function safeInline(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}
