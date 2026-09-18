import { panelLayout } from '../widgets/panel-frame.js';
import { Key, matchesKey } from '../engine/public.js';
import type { Component, Focusable } from '../rendering/component.js';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';

export type TuiInspectionTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error';

export interface TuiInspectionBadge {
  label: string;
  tone: TuiInspectionTone;
}

export interface TuiInspectionRow {
  label: string;
  value: string;
  tone?: TuiInspectionTone;
  labelTone?: TuiInspectionTone;
  labelBold?: boolean;
  detail?: string;
  detailTone?: TuiInspectionTone;
  detailMaxLines?: number;
}

export interface TuiInspectionSection {
  title: string;
  rows: readonly TuiInspectionRow[];
}

export interface TuiInspectionPanelOptions {
  title: string;
  subtitle?: string;
  badge?: TuiInspectionBadge;
  sections: readonly TuiInspectionSection[];
  warnings?: readonly string[];
  footer?: string;
  layout?: 'auto' | 'stacked';
  maxRows?: number | (() => number);
  onCancel(): void;
}

/**
 * Compact report card rendered in the interaction region above the Composer.
 */
export class TuiInspectionPanel implements Component, Focusable {
  readonly fullscreenViewport = true;
  readonly handlesViewportKeys = true;
  private _focused = false;
  private scrollOffset = 0;
  private lastPageSize = 1;
  private lastMaxScrollOffset = 0;

  constructor(private readonly options: TuiInspectionPanelOptions) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollBy(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-this.lastPageSize);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(this.lastPageSize);
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderViewport(width, resolveMaxRows(this.options.maxRows));
  }

  renderViewport(width: number, height?: number): string[] {
    const base = flatten(this.options.footer ?? 'Esc close');
    const footer = width < 44 ? `↑↓ scroll · ${base}` : `↑↓ / PgUp/PgDn scroll · ${base}`;
    const initial = panelLayout(width, height, footer);
    const body = this.renderBody(initial.contentWidth + 4, height !== undefined && height <= 12);
    const scrollable = body.length > initial.bodyHeight;
    const layout = panelLayout(width, height, scrollable ? footer : base);
    const rows = layout.bodyHeight;
    this.lastMaxScrollOffset = Math.max(0, body.length - rows);
    this.lastPageSize = Math.max(1, rows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.lastMaxScrollOffset));
    return layout.render({
      title: flatten(this.options.title),
      meta: this.options.badge
        ? paintTone(this.options.badge.label, this.options.badge.tone, true)
        : undefined,
      body: body.slice(this.scrollOffset, this.scrollOffset + rows),
    });
  }

  private renderBody(width: number, shortViewport: boolean): string[] {
    if (this.options.layout !== 'stacked' && width >= 72 && this.options.sections.length === 2) {
      return this.renderWideBody(width, shortViewport);
    }

    const lines: string[] = [];
    const innerWidth = Math.max(1, width - 4);
    if (this.options.subtitle && !shortViewport) {
      for (const line of wrapTextWithAnsi(
        chalk.hex(colors.muted)(flatten(this.options.subtitle)),
        innerWidth,
      )) {
        lines.push(line);
      }
    }

    for (const section of this.options.sections) {
      lines.push('');
      lines.push(chalk.bold.hex(colors.text)(flatten(section.title)));
      const rows = section.rows.map((row) => ({
        ...row,
        label: flatten(row.label),
        value: flatten(row.value),
        detail: row.detail ? flatten(row.detail) : undefined,
      }));
      const stacked = innerWidth < 44;
      const labelWidth = Math.min(
        Math.max(1, ...rows.map((row) => visibleWidth(row.label))),
        Math.max(1, innerWidth - 16),
      );
      for (const row of rows) {
        const tone = row.tone ?? 'neutral';
        if (stacked) {
          for (const line of wrapTextWithAnsi(paintRowLabel(row), innerWidth)) {
            lines.push(line);
          }
          const valueWidth = Math.max(1, innerWidth - 2);
          const fittedValue = isPath(row.value)
            ? paintTone(truncateStartToWidth(row.value, valueWidth), tone)
            : paintTone(row.value, tone);
          for (const line of wrapTextWithAnsi(fittedValue, valueWidth)) {
            lines.push(`  ${line}`);
          }
          for (const line of renderRowDetail(row, innerWidth - 2)) {
            lines.push(`  ${line}`);
          }
          continue;
        }

        const fittedLabel = truncateToWidth(row.label, labelWidth, '…');
        const paddedLabel = padToWidth(paintRowLabel(row, fittedLabel), labelWidth);
        const valueWidth = Math.max(1, innerWidth - labelWidth - 2);
        const valueLines = wrapTextWithAnsi(paintTone(row.value, tone), valueWidth);
        for (const [index, line] of valueLines.entries()) {
          const prefix = index === 0 ? `${paddedLabel}  ` : ' '.repeat(labelWidth + 2);
          lines.push(`${prefix}${line}`);
        }
        for (const line of renderRowDetail(row, innerWidth - 2)) {
          lines.push(`  ${line}`);
        }
      }
    }

    const warnings = inspectionWarnings(this.options.warnings);
    if (warnings.length > 0) {
      lines.push('');
      lines.push(paintWarningLabel('Warnings', true));
      for (const warning of warnings) {
        for (const line of wrapTextWithAnsi(paintWarningLabel(warning), innerWidth)) {
          lines.push(line);
        }
      }
    }

    return lines;
  }

  private renderWideBody(width: number, shortViewport: boolean): string[] {
    const innerWidth = Math.max(1, width - 4);
    const columnGap = 3;
    const leftWidth = Math.floor((innerWidth - columnGap) / 2);
    const rightWidth = Math.max(1, innerWidth - columnGap - leftWidth);
    const [leftSection, rightSection] = this.options.sections;
    if (!leftSection || !rightSection) return [];

    const lines: string[] = [];
    if (this.options.subtitle && !shortViewport) {
      for (const line of wrapTextWithAnsi(
        chalk.hex(colors.muted)(flatten(this.options.subtitle)),
        innerWidth,
      )) {
        lines.push(line);
      }
    }
    lines.push('');

    const left = renderSectionColumn(leftSection, leftWidth);
    const right = renderSectionColumn(rightSection, rightWidth);
    const warnings = inspectionWarnings(this.options.warnings);
    if (warnings.length > 0) {
      right.push(paintWarningLabel('Warnings', true));
      right.push(
        ...warnings.flatMap((warning) => wrapTextWithAnsi(paintWarningLabel(warning), rightWidth)),
      );
    }

    const rowCount = Math.max(left.length, right.length);
    for (let index = 0; index < rowCount; index += 1) {
      const leftLine = padToWidth(left[index] ?? '', leftWidth);
      const rightLine = padToWidth(right[index] ?? '', rightWidth);
      lines.push(`${leftLine} ${chalk.hex(colors.line)('│')} ${rightLine}`);
    }
    return lines;
  }

  private scrollBy(delta: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + delta, this.lastMaxScrollOffset));
  }
}

function paintTone(value: string, tone: TuiInspectionTone, bold = false): string {
  const color =
    tone === 'accent'
      ? colors.signal
      : tone === 'success'
        ? colors.success
        : tone === 'warning'
          ? colors.error
          : tone === 'error'
            ? colors.error
            : colors.text;
  const painter = bold ? chalk.bold.hex(color) : chalk.hex(color);
  return painter(value);
}

function renderSectionColumn(section: TuiInspectionSection, width: number): string[] {
  const rows = section.rows.map((row) => ({
    ...row,
    label: flatten(row.label),
    value: flatten(row.value),
    detail: row.detail ? flatten(row.detail) : undefined,
  }));
  const labelWidth = Math.min(
    Math.max(1, ...rows.map((row) => visibleWidth(row.label))),
    Math.max(1, width - 12),
  );
  const lines = [chalk.bold.hex(colors.text)(flatten(section.title))];
  for (const row of rows) {
    const fittedLabel = truncateToWidth(row.label, labelWidth, '…');
    const paddedLabel = padToWidth(paintRowLabel(row, fittedLabel), labelWidth);
    const valueWidth = Math.max(1, width - labelWidth - 2);
    const valueLines = wrapTextWithAnsi(paintTone(row.value, row.tone ?? 'neutral'), valueWidth);
    for (const [index, line] of valueLines.entries()) {
      const prefix = index === 0 ? `${paddedLabel}  ` : ' '.repeat(labelWidth + 2);
      lines.push(`${prefix}${line}`);
    }
    for (const line of renderRowDetail(row, width - 2)) lines.push(`  ${line}`);
  }
  return lines;
}

function paintRowLabel(row: TuiInspectionRow, value = row.label): string {
  if (!row.labelTone) return chalk.hex(colors.muted)(value);
  return paintTone(value, row.labelTone, row.labelBold);
}

function renderRowDetail(row: TuiInspectionRow, width: number): string[] {
  if (!row.detail) return [];
  const detail = row.detailTone
    ? paintTone(row.detail, row.detailTone)
    : chalk.hex(colors.muted)(row.detail);
  const safeWidth = Math.max(1, width);
  const lines = wrapTextWithAnsi(detail, safeWidth);
  const maxLines = row.detailMaxLines;
  if (maxLines === undefined || lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, Math.max(1, maxLines));
  const lastIndex = clipped.length - 1;
  clipped[lastIndex] = truncateToWidth(
    `${clipped[lastIndex] ?? ''}${chalk.hex(colors.dim)('…')}`,
    safeWidth,
    chalk.hex(colors.dim)('…'),
  );
  return clipped;
}

function inspectionWarnings(warnings: readonly string[] | undefined): string[] {
  const sanitized = (warnings ?? []).map((warning) => flatten(warning)).filter(Boolean);
  return sanitized.length > 3
    ? [...sanitized.slice(0, 3), `+${sanitized.length - 3} more warning(s)`]
    : sanitized;
}

function paintWarningLabel(value: string, bold = false): string {
  const marker = bold ? chalk.bold.hex(colors.error)('!') : chalk.hex(colors.error)('!');
  const text = bold ? chalk.bold.hex(colors.text)(value) : chalk.hex(colors.text)(value);
  return `${marker} ${text}`;
}

function padToWidth(value: string, width: number): string {
  const fitted = truncateToWidth(value, width, chalk.hex(colors.dim)('…'));
  return `${fitted}${' '.repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function resolveMaxRows(value: number | (() => number) | undefined): number | undefined {
  const resolved = typeof value === 'function' ? value() : value;
  if (resolved === undefined || !Number.isFinite(resolved)) return undefined;
  return Math.max(4, Math.floor(resolved));
}

function isPath(value: string): boolean {
  return /^(?:~?[\\/]|[A-Za-z]:[\\/])/u.test(value);
}

function truncateStartToWidth(value: string, width: number): string {
  if (visibleWidth(value) <= width) return value;
  if (width <= 1) return '…';
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)];
  let used = 0;
  let start = segments.length;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]?.segment;
    if (!segment) continue;
    const segmentWidth = visibleWidth(segment);
    if (used + segmentWidth > width - 1) break;
    used += segmentWidth;
    start = index;
  }
  return `…${segments
    .slice(start)
    .map((segment) => segment.segment)
    .join('')}`;
}

function flatten(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}
