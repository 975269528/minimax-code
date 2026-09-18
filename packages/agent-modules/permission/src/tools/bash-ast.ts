/**
 * Codex-aligned bash parser.
 *
 * Hand-written TypeScript reproduction of the accept/reject set implemented by
 * OpenAI Codex's tree-sitter-bash parser in `shell-command/src/bash.rs`. We do
 * NOT pull in tree-sitter; instead we re-derive the same decision boundary with
 * a quote-aware scanner. The goal is behavioural parity with Codex on the set
 * of scripts that classify as "word-only command sequences" and on the heredoc
 * single-command-prefix fallback.
 *
 * Codex parity points (see bash.rs):
 *   - A script is a "plain command sequence" iff every command is built only
 *     from bare words / quoted strings / numbers / quote-concatenations, joined
 *     ONLY by the side-effect-free operators `&&`, `||`, `;`, `|`.
 *   - Any of the following make the whole script NON-plain (returns undefined):
 *       parentheses / subshells, redirections (`>` `<` `>>` `2>` …),
 *       background `&`, command substitution `$( … )` / backticks,
 *       parameter expansion `$VAR` / `${VAR}` (even inside double quotes),
 *       variable-assignment prefix (`FOO=bar cmd`), empty command positions
 *       (leading / trailing / doubled operators), and parse errors.
 *   - Double-quoted strings keep their literal content (Codex rejects them only
 *     when they contain an expansion); single quotes are fully literal.
 *
 * Unlike Codex's AST walk we cannot rely on a grammar, so the scanner is
 * deliberately conservative: anything it is unsure about is rejected (returns
 * undefined), matching Codex's "if we cannot prove it word-only, it is not
 * auto-safe" stance.
 */

export type ShellName = 'bash' | 'zsh' | 'sh';

/** Shells whose `-lc` / `-c` script arg we are willing to parse. */
const KNOWN_SHELLS = new Set<string>(['bash', 'zsh', 'sh']);

/**
 * Extract the `(shell, script)` pair from a `bash -lc "<script>"` style argv.
 * Mirrors Codex `extract_bash_command`: exactly 3 tokens, flag is `-lc`/`-c`,
 * and the executable basename is a known shell.
 */
export function extractBashCommand(
  command: readonly string[],
): { shell: string; script: string } | undefined {
  if (command.length !== 3) return undefined;
  const [shell, flag, script] = command as [string, string, string];
  if (flag !== '-lc' && flag !== '-c') return undefined;
  if (!KNOWN_SHELLS.has(basename(shell))) return undefined;
  return { shell, script };
}

/**
 * Codex `parse_shell_lc_plain_commands`: parse the script of a `bash -lc "…"`
 * invocation into a sequence of plain commands, or undefined if it is not a
 * word-only command sequence.
 */
export function parseShellLcPlainCommands(command: readonly string[]): string[][] | undefined {
  const extracted = extractBashCommand(command);
  if (!extracted) return undefined;
  return parseScriptPlainCommands(extracted.script);
}

/**
 * Codex `try_parse_word_only_commands_sequence` operating on a raw script
 * string (the form used by Codex tests via `parse_seq`).
 */
export function parseScriptPlainCommands(script: string): string[][] | undefined {
  // Reject any whole-script construct that the word-only grammar forbids.
  if (containsForbiddenConstruct(script)) return undefined;

  const segments = splitTopLevelSegments(script);
  if (segments === undefined) return undefined; // doubled / dangling operator
  if (segments.length === 0) return undefined;

  const commands: string[][] = [];
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) return undefined; // empty command position
    const words = parsePlainCommandWords(trimmed);
    if (!words || words.length === 0) return undefined;
    if (isAssignmentPrefix(words[0]!)) return undefined; // FOO=bar cmd
    commands.push(words);
  }
  return commands;
}

/**
 * Codex `parse_shell_lc_single_command_prefix`: for a heredoc-style script with
 * exactly one command and no extra file redirect, return that command's
 * word prefix (argv). Used so heredoc invocations still match allow/prompt
 * rules by their executable prefix.
 */
export function parseShellLcSingleCommandPrefix(command: readonly string[]): string[] | undefined {
  const extracted = extractBashCommand(command);
  if (!extracted) return undefined;
  const { script } = extracted;

  if (!hasHeredoc(script)) return undefined;
  // A heredoc attaches stdin; an *extra* file redirect (`> file`) may write
  // outside the sandbox, so Codex refuses to collapse it to the prefix.
  if (hasFileRedirect(script)) return undefined;
  // Command substitution / expansion in the header is unsafe.
  const withoutBodies = stripHeredocBodies(script);
  if (containsExpansionOrSubstitution(withoutBodies)) return undefined;

  // Codex requires EXACTLY one command node. After removing heredoc bodies,
  // any trailing command (`… PY\necho done`) leaves a second command, so the
  // heredoc-stripped script must collapse to a single command. Newlines, like
  // `;`, separate commands here.
  const strippedSansHeredocOp = withoutBodies.replace(
    /<<[-~]?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/g,
    '',
  );
  if (countTopLevelCommands(strippedSansHeredocOp) !== 1) return undefined;

  const header = script.slice(0, script.indexOf('<<')).trim();
  if (header.length === 0) return undefined;
  // The header must be a single simple command: no operators joining commands.
  if (splitTopLevelSegments(header)?.length !== 1) return undefined;

  const words = parsePlainCommandWords(header);
  if (!words || words.length === 0) return undefined;
  if (isAssignmentPrefix(words[0]!)) return undefined;
  return words;
}

// ───────────────────────────────────────────────────────────────────────────
// Internal scanning helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Whole-script reject scan. Walks the source tracking quote state and rejects
 * any construct outside the word-only grammar. Single quotes are fully literal;
 * double quotes still allow `$`-expansion to be detected (Codex rejects those).
 */
function containsForbiddenConstruct(script: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    // Inside single quotes everything is literal data.
    if (inSingle) continue;

    // `$` introduces parameter / command / arithmetic expansion. Forbidden in
    // both unquoted AND double-quoted context (matches Codex rejecting
    // `echo "$HOME"`).
    if (ch === '$') return true;
    // Backtick command substitution.
    if (ch === '`') return true;

    // The remaining constructs are only meaningful OUTSIDE quotes.
    if (inDouble) continue;

    // Redirections.
    if (ch === '>' || ch === '<') return true;
    // Subshell / grouping / process substitution.
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return true;
    // Background `&` is rejected; `&&` is handled by the segment splitter and
    // is allowed, so only a lone `&` (not part of `&&`) is forbidden here.
    if (ch === '&' && script[i + 1] !== '&' && script[i - 1] !== '&') return true;
  }

  // Unbalanced quotes ⇒ parse error ⇒ reject.
  if (inSingle || inDouble || escaped) return true;
  return false;
}

/**
 * Split a script into top-level command segments on the allowed operators
 * `&&`, `||`, `;`, `|` (quote-aware). Returns undefined if it finds a doubled
 * or dangling operator (empty command position), matching Codex parse errors
 * like `ls ;;`, `ls &&`, `ls | | wc`, `&& ls`.
 */
function splitTopLevelSegments(script: string): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushSegment = (): boolean => {
    // An empty segment between two operators is an empty command position.
    if (current.trim().length === 0) return false;
    segments.push(current);
    current = '';
    return true;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    const next = script[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    // `&&` and `||`
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (!pushSegment()) return undefined;
      i += 1;
      continue;
    }
    // single `|` (pipe) and `;`
    if (ch === '|' || ch === ';') {
      if (!pushSegment()) return undefined;
      continue;
    }

    current += ch;
  }

  // Trailing operator leaves a dangling empty segment ⇒ reject.
  if (current.trim().length === 0) {
    // If we have already collected segments, a trailing-empty means a dangling
    // operator (`ls &&`). An all-empty script also yields no commands.
    return segments.length > 0 ? undefined : [];
  }
  segments.push(current);
  return segments;
}

/**
 * Parse a single simple command (already free of operators) into its argv,
 * resolving quotes and quote-concatenation. Returns undefined if the command
 * is not purely word-like (caller has already reject-scanned for `$`/`` ` ``,
 * redirects, etc., so this only tokenises).
 */
function parsePlainCommandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let hasToken = false;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const flush = (): void => {
    if (hasToken) {
      words.push(current);
    }
    current = '';
    hasToken = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (escaped) {
      current += ch;
      hasToken = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      hasToken = true; // empty quotes still produce a token
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      hasToken = true;
      continue;
    }
    if (!inSingle && !inDouble && isWhitespace(ch)) {
      flush();
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (inSingle || inDouble || escaped) return undefined;
  flush();
  return words;
}

// ───────────────────────────────────────────────────────────────────────────
// Heredoc helpers (single-command-prefix fallback)
// ───────────────────────────────────────────────────────────────────────────

function hasHeredoc(script: string): boolean {
  return /<<[-~]?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(script) || script.includes('<<');
}

/**
 * Detect a file redirect (`>`, `>>`, `<`, `2>` …) that is NOT the heredoc
 * operator. We strip heredoc operators first, then look for any remaining
 * angle-bracket redirect outside quotes.
 */
function hasFileRedirect(script: string): boolean {
  const withoutHeredoc = stripHeredocBodies(script).replace(/<<[-~]?/g, '');
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < withoutHeredoc.length; i++) {
    const ch = withoutHeredoc[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '>' || ch === '<') return true;
  }
  return false;
}

/** Remove heredoc bodies so header scans don't trip over body content. */
function stripHeredocBodies(script: string): string {
  const match = /<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(script);
  if (!match) return script;
  const delimiter = match[2]!;
  const headerEnd = script.indexOf('\n');
  if (headerEnd === -1) return script;
  const header = script.slice(0, headerEnd);
  // Drop everything from the first body line up to (and including) the closing
  // delimiter line; keep anything after the delimiter (e.g. `; echo done`).
  const lines = script.slice(headerEnd + 1).split('\n');
  const closingIdx = lines.findIndex((line) => line.trim() === delimiter);
  if (closingIdx === -1) return header;
  const tail = lines.slice(closingIdx + 1).join('\n');
  return tail.length > 0 ? `${header}\n${tail}` : header;
}

function containsExpansionOrSubstitution(text: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) continue;
    if (ch === '$' || ch === '`') return true;
  }
  return false;
}

// ───────────────────────────────────────────────────────────────────────────
// Small utilities
// ───────────────────────────────────────────────────────────────────────────

function isAssignmentPrefix(word: string): boolean {
  // `FOO=bar` / `FOO=` at the command head is a variable assignment, not a cmd.
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/**
 * Count non-empty top-level commands, treating newlines as command separators
 * in addition to `;`/`&&`/`||`/`|`. Used by the heredoc fallback to enforce
 * Codex's "exactly one command node" rule.
 */
function countTopLevelCommands(script: string): number {
  const normalized = script.replace(/\r?\n/g, ';');
  const segments = splitTopLevelSegments(normalized);
  if (segments === undefined) return -1;
  return segments.filter((segment) => segment.trim().length > 0).length;
}

function isWhitespace(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code === 32 || (code >= 9 && code <= 13);
}

function basename(p: string): string {
  const normalized = p.replaceAll('\\', '/');
  const idx = normalized.lastIndexOf('/');
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}
