import type { Component } from '../rendering/component.js';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../rendering/text.js';

const INLINE_LAYOUT_MIN_WIDTH = 46;
const MAX_LABEL_WIDTH = 18;

export interface BorderedTableRow {
  readonly label: string;
  readonly value: string;
}

export interface BorderedTableSection {
  readonly title: string;
  readonly rows: readonly BorderedTableRow[];
}

export interface BorderedTableOptions {
  readonly title: string;
  readonly badge?: string;
  readonly sections: readonly BorderedTableSection[];
  readonly footer?: string;
  readonly border?: (value: string) => string;
  readonly ellipsis?: string;
}

/** Width-safe bordered key-value table for inline TUI reports. */
export class BorderedTable implements Component {
  constructor(private readonly options: BorderedTableOptions) {}

  invalidate(): void {}

  render(rawWidth: number): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    if (width === 0) return [];
    if (width < 8) return [truncateToWidth(this.options.title, width, this.ellipsis)];

    const lines: string[] = [this.horizontal('╭', '╮', width)];
    lines.push(this.row(this.composeHeader(width - 4), width));
    const inlineLabelWidth = this.inlineLabelWidth();

    for (const section of this.options.sections) {
      lines.push(this.sectionBoundary(section.title, width));
      if (width >= INLINE_LAYOUT_MIN_WIDTH) {
        lines.push(...this.renderInlineRows(section.rows, width, inlineLabelWidth));
      } else {
        lines.push(...this.renderStackedRows(section.rows, width));
      }
    }

    if (this.options.footer) {
      lines.push(this.horizontal('├', '┤', width));
      lines.push(this.row(this.options.footer, width));
    }
    lines.push(this.horizontal('╰', '╯', width));
    return lines;
  }

  private renderInlineRows(
    rows: readonly BorderedTableRow[],
    width: number,
    labelWidth: number,
  ): string[] {
    const valueWidth = Math.max(1, width - labelWidth - 7);
    const lines: string[] = [];

    for (const row of rows) {
      const label = padToWidth(truncateToWidth(row.label, labelWidth, this.ellipsis), labelWidth);
      const values = wrapTextWithAnsi(row.value, valueWidth);
      for (const [index, value] of values.entries()) {
        const visibleLabel = index === 0 ? label : ' '.repeat(labelWidth);
        lines.push(
          `${this.border('│')} ${visibleLabel} ${this.border('│')} ${padToWidth(
            truncateToWidth(value, valueWidth, this.ellipsis),
            valueWidth,
          )} ${this.border('│')}`,
        );
      }
    }
    return lines;
  }

  private renderStackedRows(rows: readonly BorderedTableRow[], width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const valueWidth = Math.max(1, contentWidth - 2);
    const lines: string[] = [];

    for (const row of rows) {
      lines.push(this.row(row.label, width));
      for (const value of wrapTextWithAnsi(row.value, valueWidth)) {
        lines.push(this.row(`  ${value}`, width));
      }
    }
    return lines;
  }

  private composeHeader(contentWidth: number): string {
    const title = truncateToWidth(this.options.title, contentWidth, this.ellipsis);
    const badge = this.options.badge;
    if (!badge) return title;

    const badgeWidth = Math.min(visibleWidth(badge), Math.max(1, Math.floor(contentWidth * 0.45)));
    const fittedBadge = truncateToWidth(badge, badgeWidth, this.ellipsis);
    const titleWidth = Math.max(1, contentWidth - visibleWidth(fittedBadge) - 1);
    const fittedTitle = truncateToWidth(title, titleWidth, this.ellipsis);
    const gap = Math.max(0, contentWidth - visibleWidth(fittedTitle) - visibleWidth(fittedBadge));
    return `${fittedTitle}${' '.repeat(gap)}${fittedBadge}`;
  }

  private sectionBoundary(title: string, width: number): string {
    const available = Math.max(1, width - 5);
    const fittedTitle = truncateToWidth(title, available, this.ellipsis);
    const fill = Math.max(0, width - visibleWidth(fittedTitle) - 5);
    return `${this.border('├─ ')}${fittedTitle}${this.border(` ${'─'.repeat(fill)}┤`)}`;
  }

  private horizontal(left: string, right: string, width: number): string {
    return this.border(`${left}${'─'.repeat(Math.max(0, width - 2))}${right}`);
  }

  private row(content: string, width: number): string {
    const innerWidth = Math.max(1, width - 4);
    const fitted = truncateToWidth(content, innerWidth, this.ellipsis);
    return `${this.border('│')} ${padToWidth(fitted, innerWidth)} ${this.border('│')}`;
  }

  private border(value: string): string {
    return this.options.border?.(value) ?? value;
  }

  private inlineLabelWidth(): number {
    return Math.min(
      MAX_LABEL_WIDTH,
      Math.max(
        1,
        ...this.options.sections.flatMap((section) =>
          section.rows.map((row) => visibleWidth(row.label)),
        ),
      ),
    );
  }

  private get ellipsis(): string {
    return this.options.ellipsis ?? '…';
  }
}

function padToWidth(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleWidth(value)))}`;
}
