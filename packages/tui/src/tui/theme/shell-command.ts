import { highlightTuiCode, tuiChalk as chalk, tuiColors as colors } from './runtime.js';

interface CommandRange {
  readonly start: number;
  readonly end: number;
}

const MAX_SHELL_HIGHLIGHT_BYTES = 512 * 1024;
const MAX_SHELL_HIGHLIGHT_LINES = 10_000;
const MAX_SHELL_HIGHLIGHT_LINE_BYTES = 4 * 1024;
const SHELL_COMMAND_SEPARATORS = new Set(['&&', '||', '|', ';', '&', '(', '{', '\n']);
const SHELL_COMMAND_PREFIX_WORDS = new Set(['do', 'elif', 'else', 'if', 'then', 'until', 'while']);
const SHELL_RESERVED_WORDS = new Set([
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'time',
  'until',
  'while',
]);

/**
 * Resolve the executable script from Runtime tool input.
 *
 * Bash permissions and transcript cells may carry either the command itself
 * or a serialized tool payload such as `{ "command": "pnpm test" }`. Keep
 * that transport detail out of every command presentation surface.
 */
export function resolveTuiShellCommand(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (!trimmed.startsWith('{')) return input;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const command = (parsed as Readonly<Record<string, unknown>>).command;
    return typeof command === 'string' ? command : undefined;
  } catch {
    return input;
  }
}

/**
 * Mirrors Codex's whole-script Bash highlighting while guaranteeing that the
 * executable at each shell command boundary remains visually distinct. The
 * extra command-position pass is necessary because Highlight.js leaves common
 * external programs such as cp, rm, and mv in the default text scope.
 */
export function highlightTuiShellCommand(command: string): string {
  if (exceedsShellHighlightLimits(command)) return chalk.hex(colors.text)(command);
  const ranges = findShellCommandRanges(command);
  if (ranges.length === 0) return highlightTuiCode(command, 'bash').join('\n');

  const replacements = ranges.map((range, index) => ({
    ...range,
    token: command.slice(range.start, range.end),
    placeholder: uniquePlaceholder(command, index),
  }));
  let prepared = command;
  for (const replacement of [...replacements].reverse()) {
    prepared = `${prepared.slice(0, replacement.start)}${replacement.placeholder}${prepared.slice(replacement.end)}`;
  }

  let highlighted = highlightTuiCode(prepared, 'bash').join('\n');
  for (const replacement of replacements) {
    highlighted = highlighted.replace(
      replacement.placeholder,
      `${chalk.bold.hex(colors.accent)(replacement.token)}${foregroundPrefix(colors.text)}`,
    );
  }
  return highlighted;
}

export function highlightTuiShellCommandLines(command: string): string[] {
  return highlightTuiShellCommand(command).split('\n');
}

function exceedsShellHighlightLimits(command: string): boolean {
  if (utf8ByteLength(command) > MAX_SHELL_HIGHLIGHT_BYTES) return true;
  const lines = command.split('\n');
  return (
    lines.length > MAX_SHELL_HIGHLIGHT_LINES ||
    lines.some((line) => utf8ByteLength(line) > MAX_SHELL_HIGHLIGHT_LINE_BYTES)
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function findShellCommandRanges(command: string): CommandRange[] {
  const ranges: CommandRange[] = [];
  let expectCommand = true;
  let index = 0;

  while (index < command.length) {
    const character = command[index] ?? '';
    if (character === ' ' || character === '\t' || character === '\r') {
      index += 1;
      continue;
    }
    if (character === '#') {
      index = skipShellComment(command, index);
      continue;
    }

    const operator = readShellOperator(command, index);
    if (operator) {
      if (SHELL_COMMAND_SEPARATORS.has(operator.value)) expectCommand = true;
      index = operator.end;
      continue;
    }

    const word = readShellWord(command, index);
    if (word.end === index) {
      index += 1;
      continue;
    }
    index = word.end;
    if (!expectCommand) continue;

    const plainWord = unquoteShellWord(command.slice(word.start, word.end));
    if (isShellAssignment(plainWord)) continue;
    if (SHELL_RESERVED_WORDS.has(plainWord)) {
      expectCommand = SHELL_COMMAND_PREFIX_WORDS.has(plainWord);
      continue;
    }
    ranges.push(word);
    expectCommand = false;
  }
  return ranges;
}

function readShellOperator(
  command: string,
  start: number,
): { readonly value: string; readonly end: number } | undefined {
  const pair = command.slice(start, start + 2);
  if (pair === '&&' || pair === '||') return { value: pair, end: start + 2 };
  const character = command[start];
  if ('|;&(){}\n<>'.includes(character ?? '')) {
    return { value: character ?? '', end: start + 1 };
  }
  return undefined;
}

function readShellWord(command: string, start: number): CommandRange {
  let index = start;
  let quote: "'" | '"' | undefined;
  while (index < command.length) {
    const character = command[index] ?? '';
    if (character === '\\') {
      index = Math.min(command.length, index + 2);
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (/\s/u.test(character) || '|;&(){}<>'.includes(character)) break;
    index += 1;
  }
  return { start, end: index };
}

function skipShellComment(command: string, start: number): number {
  const newline = command.indexOf('\n', start);
  return newline === -1 ? command.length : newline;
}

function unquoteShellWord(word: string): string {
  if (word.length >= 2) {
    const first = word[0];
    const last = word.at(-1);
    if ((first === "'" || first === '"') && last === first) return word.slice(1, -1);
  }
  return word;
}

function isShellAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(word);
}

function uniquePlaceholder(command: string, index: number): string {
  let attempt = `MCODECOMMANDTOKEN${String(index)}X`;
  while (command.includes(attempt)) attempt += 'X';
  return attempt;
}

function foregroundPrefix(color: string): string {
  const marker = 'MCODECOLOR';
  const styled = chalk.hex(color)(marker);
  const markerIndex = styled.indexOf(marker);
  return markerIndex < 0 ? '' : styled.slice(0, markerIndex);
}
