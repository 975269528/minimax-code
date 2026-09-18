import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { BorderedTable, type BorderedTableSection } from '../foundation/bordered-table.js';
import { truncateToWidth } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { ContextVisualization } from './context-visualization.js';
import { StatusVisualization } from './status-visualization.js';
import { UsageVisualization } from './usage-visualization.js';
import type {
  TranscriptInspectionReport,
  TranscriptInspectionRow,
  TranscriptInspectionTone,
} from './model.js';

const TRANSCRIPT_HORIZONTAL_INSET = 2;
const MIN_INSET_WIDTH = 8;

export function renderTranscriptInspection(
  report: TranscriptInspectionReport,
  width: number,
): string[] {
  const safeWidth = Math.max(0, Math.floor(width));
  if (safeWidth === 0) return [];
  if (safeWidth < 4) return [truncateToWidth(flatten(report.title), safeWidth, '…')];
  const inset = safeWidth >= MIN_INSET_WIDTH ? TRANSCRIPT_HORIZONTAL_INSET : 0;
  const contentWidth = safeWidth - inset * 2;
  if (report.visualization?.kind === 'context') {
    return applyHorizontalInset(
      new ContextVisualization(report.visualization).render(contentWidth),
      inset,
      contentWidth,
    );
  }
  if (report.visualization?.kind === 'usage') {
    return applyHorizontalInset(
      new UsageVisualization(report.visualization).render(contentWidth),
      inset,
      contentWidth,
    );
  }
  if (report.visualization?.kind === 'status') {
    return applyHorizontalInset(
      new StatusVisualization(report).render(contentWidth),
      inset,
      contentWidth,
    );
  }
  const warnings = sanitizeWarnings(report.warnings);
  const sections: BorderedTableSection[] = report.sections.map((section) => ({
    title: chalk.bold.hex(colors.signal)(flatten(section.title)),
    rows: section.rows.map(styleRow),
  }));
  if (warnings.length > 0) {
    sections.push({
      title: chalk.bold.hex(colors.warning)('Warnings'),
      rows: warnings.map((warning) => ({
        label: paintTone('!', 'warning'),
        value: paintTone(warning, 'warning'),
      })),
    });
  }

  return applyHorizontalInset(
    new BorderedTable({
      title: chalk.bold.hex(colors.text)(flatten(report.title)),
      ...(report.badge
        ? {
            badge: paintTone(
              `${badgeMarker(report.badge.tone)} ${flatten(report.badge.label)}`,
              report.badge.tone,
            ),
          }
        : {}),
      sections,
      ...(report.footer ? { footer: chalk.hex(colors.dim)(flatten(report.footer)) } : {}),
      border: (value) => chalk.hex(colors.line)(value),
      ellipsis: chalk.hex(colors.dim)('…'),
    }).render(contentWidth),
    inset,
    contentWidth,
  );
}

function applyHorizontalInset(
  lines: readonly string[],
  inset: number,
  contentWidth: number,
): string[] {
  if (inset === 0) return [...lines];
  const margin = ' '.repeat(inset);
  return lines.map(
    (line) =>
      `${margin}${truncateToWidth(line, contentWidth, chalk.hex(colors.dim)('…'))}${margin}`,
  );
}

function styleRow(row: TranscriptInspectionRow): { label: string; value: string } {
  return {
    label: chalk.hex(colors.muted)(flatten(row.label)),
    value: paintTone(flatten(row.value), row.tone ?? 'neutral'),
  };
}

function sanitizeWarnings(warnings: readonly string[] | undefined): string[] {
  const values = (warnings ?? []).map(flatten).filter(Boolean);
  return values.length > 3 ? [...values.slice(0, 3), `${values.length - 3} more warnings`] : values;
}

function flatten(value: string): string {
  return sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
}

function badgeMarker(tone: TranscriptInspectionTone): string {
  if (tone === 'success') return '●';
  if (tone === 'warning' || tone === 'error') return '!';
  if (tone === 'accent') return '◆';
  return '○';
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
