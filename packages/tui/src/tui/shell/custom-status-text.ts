import type { TuiCustomStatusLineConfig } from '@mavis/config';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import {
  sliceByColumn,
  stripAnsi,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '../rendering/text.js';

// Consume whole control strings before looking for SGR, including unterminated
// strings from bounded stdout. Embedded colors must not escape OSC/DCS payloads.
const TERMINAL_CONTROLS = new RegExp(
  [
    String.raw`(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)`,
    String.raw`(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)`,
    String.raw`\u001b[ -/]*[0-~]`,
    String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  ].join('|'),
  'gu',
);
const RESET = '\u001b[0m';

/** Keep color-only SGR sequences; reject mixed attributes and malformed colors. */
function allowColorSequence(sequence: string): string {
  const match = /^(?:\u001b\[|\u009b)([0-9;]*)m$/u.exec(sequence);
  if (!match) return '';
  const params = (match[1] ?? '').split(';').map(Number);
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index];
    if (code === undefined) return '';
    if (code === 38 || code === 48) {
      const mode = params[index + 1];
      const count = mode === 5 ? 1 : mode === 2 ? 3 : 0;
      const components = params.slice(index + 2, index + 2 + count);
      if (
        count === 0 ||
        components.length !== count ||
        components.some((value) => value < 0 || value > 255)
      )
        return '';
      index += count + 1;
    } else if (
      code !== 0 &&
      code !== 39 &&
      code !== 49 &&
      !(code >= 30 && code <= 37) &&
      !(code >= 40 && code <= 47) &&
      !(code >= 90 && code <= 97) &&
      !(code >= 100 && code <= 107)
    ) {
      return '';
    }
  }
  return `\u001b[${params.join(';')}m`;
}

/** Render bounded rows without allowing command output to control the terminal. */
export function renderCustomStatusLines(
  text: string,
  width: number,
  colorMode?: TuiCustomStatusLineConfig['colorMode'],
): string[] {
  const ansi = colorMode === 'ansi' && chalk.level > 0;
  const sanitized =
    colorMode === 'ansi'
      ? text.replace(TERMINAL_CONTROLS, (sequence) => (ansi ? allowColorSequence(sequence) : ''))
      : sanitizeTerminalText(text);
  const normalized = sanitized.replace(/\r\n/gu, '\n').replace(/[\r\t]/gu, ' ');
  // An infinite wrap width carries colors across explicit newlines without
  // introducing extra rows. Clipping below still uses the existing width engine.
  return wrapTextWithAnsi(normalized, Number.POSITIVE_INFINITY).flatMap((line) => {
    const plain = stripAnsi(line);
    const trimmed = plain.trim();
    if (!trimmed) return [];
    const leadingWidth = visibleWidth(plain) - visibleWidth(plain.trimStart());
    const content = sliceByColumn(line, leadingWidth, visibleWidth(trimmed));
    const clipped = truncateToWidth(content, width, '…');
    if (!clipped) return [];
    // Reset before padding, separators and the original footer. Explicitly reset
    // the start too, so an uncolored prefix cannot inherit another component.
    return [ansi ? RESET + clipped + RESET : chalk.hex(colors.muted)(clipped)];
  });
}
