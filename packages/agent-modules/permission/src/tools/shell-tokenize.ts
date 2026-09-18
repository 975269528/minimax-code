/**
 * Shell tokenisation primitive used by the bash permission gate and the
 * classifier. Extracted to a dedicated module so both consumers
 * import from the same source — required because the classifier
 * already imports the SAFE first-word set + destructive-kill helper from
 * `bash-permission.ts` would create a circular reference if `shellTokenize`
 * were re-imported in the other direction.
 *
 * Splits an input shell command string into individual arguments,
 * correctly handling single quotes, double quotes, and backslash escaping.
 * Returns unquoted values (e.g. `"my file"` → `my file`).
 *
 * Notes for callers:
 *   - This tokeniser does NOT evaluate command substitution (`$(...)`,
 *     backticks), parameter expansion (`$VAR`), or glob expansion. The
 *     literal text of those constructs is preserved as a token.
 *   - Backslash escapes a single following character outside of single
 *     quotes (POSIX rule for double-quoted / unquoted contexts).
 *   - Single quotes preserve everything inside literally, including
 *     backslashes and double quotes (no escape processing).
 *   - Double quotes preserve everything except backslash + escaped char.
 */
export interface ShellToken {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

export function shellTokenize(input: string): string[] {
  return shellTokenizeWithMetadata(input).map((token) => token.value);
}

export function shellTokenizeWithMetadata(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = '';
  let currentStart: number | undefined;
  let currentQuoted = false;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  const startCurrent = (index: number): void => {
    currentStart ??= index;
  };

  const flushCurrent = (end: number): void => {
    if (current.length > 0) {
      tokens.push({
        value: current,
        start: currentStart ?? end,
        end,
        quoted: currentQuoted,
      });
    }
    current = '';
    currentStart = undefined;
    currentQuoted = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (escaped) {
      startCurrent(i - 1);
      current += ch;
      currentQuoted = true;
      escaped = false;
      continue;
    }

    if (ch === '\\' && !inSingleQuote) {
      const next = input[i + 1];
      if (next === '\n') {
        i += 1;
        continue;
      }
      if (next === '\r' && input[i + 2] === '\n') {
        i += 2;
        continue;
      }
      startCurrent(i);
      currentQuoted = true;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      startCurrent(i);
      currentQuoted = true;
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      startCurrent(i);
      currentQuoted = true;
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (isShellWhitespace(ch) && !inSingleQuote && !inDoubleQuote) {
      flushCurrent(i);
      continue;
    }

    startCurrent(i);
    current += ch;
  }

  flushCurrent(input.length);

  return tokens;
}

function isShellWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
}
