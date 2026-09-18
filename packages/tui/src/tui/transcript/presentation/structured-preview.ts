import type {
  TuiStructuredPreview,
  TuiStructuredPreviewBlock,
} from '../../../types/runtime-models.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { applyBackgroundToLine, truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { highlightDiffContents, highlightFileLines } from './syntax-highlight.js';
import { tuiChalk as chalk, tuiColors as colors } from '../../theme/runtime.js';

export interface RenderTuiStructuredPreviewOptions {
  readonly maxBodyLines?: number;
  readonly prefix?: string;
}

export function renderTuiStructuredPreview(
  preview: TuiStructuredPreview,
  width: number,
  options: RenderTuiStructuredPreviewOptions = {},
): string[] {
  const normalizedWidth = Math.max(0, Math.floor(width));
  if (normalizedWidth === 0 || preview.blocks.length === 0) return [];
  const prefix = options.prefix ?? '  ';
  let remainingBodyLines = Math.max(1, options.maxBodyLines ?? 14);
  const lines: string[] = [];

  for (const [index, block] of preview.blocks.entries()) {
    if (remainingBodyLines <= 0) {
      const remainingBlocks = preview.blocks.length - index;
      lines.push(
        fitPreviewLine(
          `${prefix}${chalk.hex(colors.dim)('└')} ${chalk.hex(colors.muted)(`${remainingBlocks} more ${remainingBlocks === 1 ? 'change' : 'changes'} hidden`)}`,
          normalizedWidth,
        ),
      );
      break;
    }
    const rendered = renderBlock(block, preview, normalizedWidth, prefix, remainingBodyLines);
    lines.push(...rendered.lines);
    remainingBodyLines -= rendered.bodyLines;
  }
  return lines;
}

function renderBlock(
  block: TuiStructuredPreviewBlock,
  preview: TuiStructuredPreview,
  width: number,
  prefix: string,
  maxBodyLines: number,
): { lines: string[]; bodyLines: number } {
  const path = sanitizeTerminalText(block.path ?? 'file');
  const state = previewStateLabel(preview.state);
  const summary =
    block.kind === 'diff'
      ? `${chalk.hex(colors.success)(`+${block.addedLines}`)} ${chalk.hex(colors.error)(`-${block.removedLines}`)}`
      : block.kind === 'file'
        ? `${block.lineCount} ${block.lineCount === 1 ? 'line' : 'lines'}`
        : undefined;
  const header = fitPreviewLine(
    `${prefix}${chalk.hex(colors.dim)('┌')} ${chalk.bold.hex(colors.text)(path)}${summary ? chalk.hex(colors.muted)(` · ${summary}`) : ''}${chalk.hex(previewStateColor(preview.state))(` · ${state}`)}`,
    width,
  );

  if (block.kind === 'summary') {
    return {
      lines: [
        header,
        fitPreviewLine(
          `${prefix}${chalk.hex(colors.dim)('└')} ${chalk.hex(colors.muted)(sanitizeTerminalText(block.message))}`,
          width,
        ),
      ],
      bodyLines: 1,
    };
  }

  const sourceLines =
    block.kind === 'diff'
      ? sanitizeTerminalText(block.diff).split('\n')
      : sanitizeTerminalText(block.content).split('\n');
  const visibleLines = sourceLines.slice(0, maxBodyLines);
  const highlightedFileLines =
    block.kind === 'file' ? highlightFileLines(visibleLines.join('\n'), block.path) : [];
  const highlightedDiffContents =
    block.kind === 'diff' ? highlightDiffContents(visibleLines, block.path) : [];
  const omittedLines =
    Math.max(0, sourceLines.length - visibleLines.length) + (block.omittedLines ?? 0);
  const numberWidth = block.kind === 'file' ? String(block.lineCount).length : 0;
  const bodyPrefix = `${prefix}${chalk.hex(colors.dim)('│')} `;
  const bodyWidth = Math.max(1, width - visibleWidth(bodyPrefix));
  const body = visibleLines.map((line, index) => {
    const content =
      block.kind === 'diff'
        ? colorDiffLine(line, highlightedDiffContents[index] ?? '', bodyWidth)
        : `${chalk.hex(colors.dim)(String(index + 1).padStart(numberWidth))} ${highlightedFileLines[index] ?? chalk.hex(colors.text)(line)}`;
    return fitPreviewLine(`${bodyPrefix}${content}`, width);
  });
  const footerLabel =
    omittedLines > 0
      ? `${omittedLines} ${omittedLines === 1 ? 'line' : 'lines'} hidden`
      : block.truncated
        ? 'Preview truncated'
        : undefined;
  const footer = footerLabel
    ? [
        fitPreviewLine(
          `${prefix}${chalk.hex(colors.dim)('└')} ${chalk.hex(colors.muted)(footerLabel)}`,
          width,
        ),
      ]
    : [];
  return { lines: [header, ...body, ...footer], bodyLines: visibleLines.length };
}

function colorDiffLine(line: string, highlightedContent: string, width: number): string {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    const content = `${chalk.bold.hex(colors.success)('+')}${highlightedContent}`;
    return applyBackgroundToLine(content, width, chalk.bgHex(colors.diffAddedBg));
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    const content = `${chalk.bold.hex(colors.error)('-')}${highlightedContent}`;
    return applyBackgroundToLine(content, width, chalk.bgHex(colors.diffRemovedBg));
  }
  if (line.startsWith('@@')) return chalk.hex(colors.accent)(line);
  if (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return chalk.hex(colors.muted)(line);
  }
  if (line.startsWith(' ')) {
    return `${chalk.hex(colors.dim)(' ')}${highlightedContent}`;
  }
  return highlightedContent || chalk.hex(colors.muted)(line);
}

function previewStateLabel(state: TuiStructuredPreview['state']): string {
  if (state === 'applied') return 'Applied';
  if (state === 'not-applied') return 'Not applied';
  return 'Proposed';
}

function previewStateColor(state: TuiStructuredPreview['state']): string {
  if (state === 'applied') return colors.success;
  if (state === 'not-applied') return colors.error;
  return colors.warning;
}

function fitPreviewLine(value: string, width: number): string {
  return truncateToWidth(value, width, chalk.hex(colors.muted)('…'));
}
