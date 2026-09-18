import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../rendering/text.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import type { TranscriptCell } from './model.js';

export function renderShellBlock(cell: TranscriptCell, width: number): string[] {
  const columns = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (columns === 0) return [];
  const command = sanitizeTerminalText(cell.title ?? '');
  const output = sanitizeTerminalText(cell.content).replace(/\r\n/gu, '\n').replace(/\n$/u, '');
  const footer = sanitizeTerminalText(cell.detail ?? '');
  const border = chalk.hex(colors.warning);
  const statusColor =
    cell.status === 'failed'
      ? colors.error
      : cell.status === 'succeeded'
        ? colors.success
        : colors.warning;
  const marker =
    cell.status === 'failed'
      ? '×'
      : cell.status === 'succeeded'
        ? '✓'
        : cell.status === 'cancelled'
          ? '○'
          : '●';
  const heading = command.startsWith('!!') ? 'Shell · Local only' : 'Shell';
  const status = `${marker} ${footer}`;
  if (columns < 5) {
    return wrapTextWithAnsi(`${heading}\n${command}\n${output}\n${status}`, columns).map((line) =>
      border(truncateToWidth(line, columns, '')),
    );
  }
  const innerWidth = columns - 4;
  const background = (line: string) => chalk.bgHex(colors.userMessageBg)(line);
  const row = (line: string) => {
    const clipped = truncateToWidth(line, innerWidth, '');
    return background(
      `${border('│')} ${clipped}${' '.repeat(innerWidth - visibleWidth(clipped))} ${border('│')}`,
    );
  };
  const rule = (left: string, right: string, label = '') => {
    const text = truncateToWidth(label ? `─ ${label} ` : '', columns - 2, '');
    return background(
      border(`${left}${text}${'─'.repeat(columns - 2 - visibleWidth(text))}${right}`),
    );
  };
  const wrap = (text: string) => wrapTextWithAnsi(text.replace(/\t/gu, '    '), innerWidth);
  const emptyOutput = cell.status === 'running' ? 'Waiting for output…' : 'No output';
  return [
    rule('╭', '╮', heading),
    ...wrap(command).map((line) => row(chalk.bold.hex(colors.warning)(line))),
    rule('├', '┤'),
    ...(output
      ? wrap(output).map((line) => row(chalk.hex(colors.text)(line)))
      : wrap(emptyOutput).map((line) => row(chalk.hex(colors.muted)(line)))),
    rule('├', '┤'),
    ...wrap(status).map((line) => row(chalk.hex(statusColor)(line))),
    rule('╰', '╯'),
  ];
}
