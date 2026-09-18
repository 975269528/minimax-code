import { ShellCompletionSource, escapeShellCompletion } from '../../host/shell-completion.js';
import type { AutocompleteItem, AutocompleteProvider } from '../widgets/autocomplete.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';

interface ShellWord {
  start: number;
  end: number;
  value: string;
  command: boolean;
  directoriesOnly: boolean;
}

/** Completes literal shell words; substitutions and compound syntax are left to the shell. */
export class TuiBashAutocomplete implements AutocompleteProvider {
  constructor(
    private readonly cwd: () => string,
    private readonly source = new ShellCompletionSource(),
  ) {}

  isShellInput(lines: string[]): boolean {
    return lines.join('\n').trimStart().startsWith('!');
  }

  shouldAutoTriggerCompletion(): boolean {
    return false;
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.word(lines, cursorLine, cursorCol) !== undefined;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ) {
    const word = this.word(lines, cursorLine, cursorCol);
    if (!word) return null;
    const candidates = await this.source.complete(
      word.value,
      this.cwd(),
      word.command,
      word.directoriesOnly,
      options.signal,
    );
    if (options.signal.aborted || candidates.length === 0) return null;
    return {
      // Keep shell candidates out of slash-specific layout and telemetry.
      prefix: `!${word.value}`,
      applyOnEnter: false,
      items: candidates.map((candidate) => ({
        value: escapeShellCompletion(candidate.value, this.source.windows),
        label: sanitizeTerminalText(
          `${candidate.value.split('/').filter(Boolean).at(-1) ?? candidate.value}${candidate.directory ? '/' : ''}`,
        ),
        description: word.command ? 'Command' : sanitizeTerminalText(candidate.value),
      })),
    };
  }

  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem) {
    const word = this.word(lines, cursorLine, cursorCol);
    if (!word) return { lines, cursorLine, cursorCol };
    const line = lines[cursorLine] ?? '';
    const suffix = line.slice(word.end);
    const space = item.label.endsWith('/') || /^\s/u.test(suffix) ? '' : ' ';
    const inserted = `${item.value}${space}`;
    const next = [...lines];
    next[cursorLine] = `${line.slice(0, word.start)}${inserted}${suffix}`;
    return { lines: next, cursorLine, cursorCol: word.start + inserted.length };
  }

  private word(lines: string[], cursorLine: number, cursorCol: number): ShellWord | undefined {
    if (!this.isShellInput(lines)) return undefined;
    // Complete one physical command line; multiline shell syntax remains untouched.
    if (cursorLine !== 0) return undefined;
    const line = lines[0] ?? '';
    const bang = /^\s*!!?/u.exec(line);
    if (!bang || cursorCol < bang[0].length) return undefined;
    let start = bang[0].length;
    let quote = '';
    let escaped = false;
    let value = '';
    let command = true;
    let commandName = '';
    const escape = this.source.windows ? '`' : '\\';
    for (let index = start; index < cursorCol; index += 1) {
      const char = line[index]!;
      if (escaped) {
        value += char;
        escaped = false;
        continue;
      }
      if (char === escape && quote !== "'") {
        if (!this.source.windows && quote === '"' && !/[\\$`"\n]/u.test(line[index + 1] ?? '')) {
          value += char;
          continue;
        }
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
        else if (quote === '"' && /[$`]/u.test(char)) return undefined;
        else value += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/[$`(){}<>]/u.test(char)) return undefined;
      if (/\s/u.test(char) || /[|;&]/u.test(char)) {
        if (value && command) {
          commandName = value;
          command = false;
        }
        if (/[|;&]/u.test(char)) {
          command = true;
          commandName = '';
        }
        start = index + 1;
        value = '';
      } else value += char;
    }
    if (escaped || (command && value.length === 0)) return undefined;
    let end = cursorCol;
    for (; end < line.length; end += 1) {
      const char = line[end]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === escape && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (quote === '"' && /[$`]/u.test(char)) return undefined;
        if (char === quote) quote = '';
        continue;
      }
      if (/[$`(){}]/u.test(char)) return undefined;
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/[\s|;&<>]/u.test(char)) break;
    }
    return {
      start,
      end,
      value,
      command,
      directoriesOnly: ['cd', 'Set-Location'].includes(commandName),
    };
  }
}
