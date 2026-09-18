import type { Component } from '../rendering/component.js';
import { visibleWidth, wrapTextWithAnsi } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { renderCapacityBar, remainingCapacityTone } from './capacity-meter.js';
import type {
  TranscriptInspectionReport,
  TranscriptInspectionRow,
  TranscriptInspectionSection,
  TranscriptInspectionTone,
  TranscriptUsageAccountRow,
} from './model.js';

const MAX_CONTENT_WIDTH = 128;

/** A compact configuration summary with account quota beneath the current Session. */
export class StatusVisualization implements Component {
  constructor(private readonly report: TranscriptInspectionReport) {}

  invalidate(): void {}

  render(rawWidth: number): string[] {
    const width = Math.min(MAX_CONTENT_WIDTH, Math.max(0, Math.floor(rawWidth)));
    if (width === 0) return [];
    const title = chalk.bold.hex(colors.text)(`▌ ${flatten(this.report.title)}`);
    const badge = this.report.badge;
    const badgeLabel = badge
      ? paintTone(`${badgeMarker(badge.tone)} ${humanBadge(badge.label)}`, badge.tone)
      : '';
    const lines =
      badgeLabel && visibleWidth(title) + 2 + visibleWidth(badgeLabel) <= width
        ? [
            `${title}${' '.repeat(width - visibleWidth(title) - visibleWidth(badgeLabel))}${badgeLabel}`,
          ]
        : [
            ...wrapTextWithAnsi(title, width),
            ...(badgeLabel ? wrapTextWithAnsi(badgeLabel, width) : []),
          ];
    const rows = statusRows(this.report.sections);
    const labelWidth = Math.min(18, Math.max(0, ...rows.map((row) => visibleWidth(row.label))));
    if (rows.length) lines.push('', ...rows.flatMap((row) => renderRow(row, width, labelWidth)));

    const quota =
      this.report.visualization?.kind === 'status'
        ? (this.report.visualization.quotaRows ?? [])
        : [];
    if (quota.length) {
      lines.push('', ...quota.flatMap((row) => renderQuotaRow(row, width, labelWidth)));
    }

    const warnings = (this.report.warnings ?? []).map(flatten).filter(Boolean);
    if (warnings.length) {
      lines.push(
        '',
        ...wrapTextWithAnsi(chalk.bold.hex(colors.warning)('! Needs attention'), width),
      );
      for (const warning of warnings) {
        lines.push(...wrapTextWithAnsi(chalk.hex(colors.warning)(`! ${warning}`), width));
      }
    }
    if (this.report.footer) {
      lines.push(
        '',
        ...wrapTextWithAnsi(chalk.hex(colors.dim)(flatten(this.report.footer)), width),
      );
    }
    return lines;
  }
}

function statusRows(sections: readonly TranscriptInspectionSection[]): TranscriptInspectionRow[] {
  const order = ['Model', 'Workspace', 'Permissions', 'Instructions', 'Account', 'Mode', 'Session'];
  return order.flatMap((title) => {
    const section = sections.find((candidate) => candidate.title === title);
    if (!section) return [];
    const rows = section.rows;
    const find = (label: string) => rows.find((row) => row.label === label);
    if (title === 'Model') {
      const model = find('Model');
      if (!model) return [...rows];
      const effort = find('Think effort');
      const thinking = find('Thinking');
      const detail = effort
        ? `${effort.value} effort`
        : thinking
          ? `Thinking ${thinking.value.toLocaleLowerCase('en-US')}`
          : undefined;
      return [{ ...model, value: `${model.value}${detail ? ` (${detail})` : ''}` }];
    }
    if (title === 'Workspace') {
      const worktree = find('Worktree');
      return rows
        .filter((row) => row !== worktree)
        .map((row) =>
          row.label === 'Branch' && worktree
            ? { ...row, value: `${row.value} · ${worktree.value}` }
            : row,
        );
    }
    if (title === 'Account') {
      const plan = find('Plan');
      const source = find('Model source');
      return rows
        .filter((row) => row.label === 'Account' || row === source)
        .map((row) =>
          row.label === 'Account' && plan ? { ...row, value: `${row.value} (${plan.value})` } : row,
        );
    }
    return rows.map((row) => (row.label === 'Session ID' ? { ...row, label: 'Session' } : row));
  });
}

function renderRow(
  row: TranscriptInspectionRow,
  width: number,
  labelWidth: number,
  renderedValue = paintTone(flatten(row.value), row.tone ?? 'neutral'),
): string[] {
  const label = flatten(row.label);
  const paintedLabel = chalk.hex(colors.muted)(`${label}:`);
  if (width < labelWidth + 18) {
    return [...wrapTextWithAnsi(paintedLabel, width), ...wrapTextWithAnsi(renderedValue, width)];
  }
  const indent = labelWidth + 2;
  const valueLines = wrapTextWithAnsi(renderedValue, width - indent);
  return valueLines.map(
    (line, index) =>
      `${index === 0 ? `${paintedLabel}${' '.repeat(Math.max(1, labelWidth - visibleWidth(label) + 1))}` : ' '.repeat(indent)}${line}`,
  );
}

function renderQuotaRow(
  row: TranscriptUsageAccountRow,
  width: number,
  labelWidth: number,
): string[] {
  if (row.remainingRatio === undefined || !Number.isFinite(row.remainingRatio) || width < 32) {
    return renderRow(row, width, labelWidth);
  }
  const valueWidth = width < labelWidth + 18 ? width : width - labelWidth - 2;
  const bar = renderCapacityBar(row.remainingRatio, {
    width: Math.min(24, Math.max(4, valueWidth - 3)),
    tone: remainingCapacityTone(row.remainingRatio),
  });
  const value = paintTone(flatten(row.value), row.tone ?? 'neutral');
  return renderRow(row, width, labelWidth, `${bar} ${value}`);
}

function badgeMarker(tone: TranscriptInspectionTone): string {
  if (tone === 'success') return '●';
  if (tone === 'warning' || tone === 'error') return '!';
  if (tone === 'accent') return '◆';
  return '○';
}

function humanBadge(value: string): string {
  const normalized = flatten(value).toLocaleLowerCase('en-US');
  return normalized ? `${normalized[0]?.toLocaleUpperCase('en-US')}${normalized.slice(1)}` : '';
}

function paintTone(value: string, tone: TranscriptInspectionTone): string {
  const color =
    tone === 'success'
      ? colors.success
      : tone === 'warning'
        ? colors.warning
        : tone === 'error'
          ? colors.error
          : tone === 'accent'
            ? colors.signal
            : colors.text;
  return chalk.hex(color)(value);
}

function flatten(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}
