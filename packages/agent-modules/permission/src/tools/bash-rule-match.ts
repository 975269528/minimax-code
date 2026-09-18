/**
 * Bash rule parsing + matching primitives.
 *
 * Extracted from `bash-permission.ts` to keep that module under the
 * 2000-line pre-commit block. Pure functions on strings — no I/O,
 * no permission state. Consumed by Step 5 user-allow gate and the
 * suggestion generator in `bash-checker.ts`.
 *
 * Rule shapes:
 *   - `git status`      → exact match
 *   - `npm:*`           → prefix match (literal `command === prefix`
 *                         OR `command.startsWith(prefix + ' ')`)
 *   - `npm run *`       → wildcard match (case-insensitive, `*` → `.*`,
 *                         `\*` literal `*`, `\\` literal `\`)
 */

import { logger, backgroundCtx } from '../host-utils.js';
import type { ShellPermissionRule } from '../types.js';
import { parseScriptPlainCommands } from './bash-ast.js';

const ESCAPED_STAR_SENTINEL = '\0STAR\0';
const ESCAPED_BACKSLASH_SENTINEL = '\0BSLASH\0';

export type CompiledShellPermissionRule =
  | Extract<ShellPermissionRule, { type: 'exact' }>
  | Extract<ShellPermissionRule, { type: 'prefix' }>
  | Extract<ShellPermissionRule, { type: 'argvPrefix' }>
  | { type: 'wildcard'; pattern: string; regex: RegExp | null };

/**
 * Encode a tokenised argv into the persisted rule-content string for an
 * argv-prefix rule. Codex-aligned: the stored form is a JSON array of the exact
 * command tokens (`["cargo","build","--release"]`), so a later invocation must
 * share that argv prefix to match. Mirrors Codex
 * `canonicalize_command_for_approval` collapsing a plain command to its argv.
 */
export function encodeArgvPrefixRule(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

/** Decode a rule-content string into an argv array iff it is a JSON string[]. */
function tryDecodeArgvPrefix(ruleContent: string): string[] | undefined {
  const trimmed = ruleContent.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every((item) => typeof item === 'string')
  ) {
    return parsed as string[];
  }
  return undefined;
}

/**
 * Parse a rule's ruleContent into a typed ShellPermissionRule.
 *
 * | Syntax                          | Type        |
 * |---------------------------------|-------------|
 * | `["cargo","build"]` (JSON argv) | argvPrefix  |
 * | `git status`                    | exact       |
 * | `npm:*`                         | prefix      |
 * | `npm run *`                     | wildcard    |
 */
export function parseShellRule(ruleContent: string): ShellPermissionRule {
  // Codex-aligned argv-prefix rule: a JSON array of command tokens.
  const argv = tryDecodeArgvPrefix(ruleContent);
  if (argv) {
    return { type: 'argvPrefix', argv };
  }

  // Prefix syntax: "command:*" or "git commit:*"
  const prefixMatch = ruleContent.match(/^(.+):\*$/);
  if (prefixMatch?.[1] && !containsUnescapedWildcard(prefixMatch[1])) {
    return { type: 'prefix', prefix: prefixMatch[1] };
  }

  // Wildcard: contains unescaped *
  if (containsUnescapedWildcard(ruleContent)) {
    return { type: 'wildcard', pattern: ruleContent };
  }

  // Exact match
  return { type: 'exact', command: ruleContent };
}

export function compileShellRule(ruleContent: string): CompiledShellPermissionRule {
  const parsed = parseShellRule(ruleContent);
  if (parsed.type !== 'wildcard') return parsed;
  return { ...parsed, regex: compileWildcardPattern(parsed.pattern) };
}

function containsUnescapedWildcard(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '*' && (i === 0 || s[i - 1] !== '\\')) {
      return true;
    }
  }
  return false;
}

/**
 * Match a command against a wildcard pattern.
 *
 * - `*` is converted to `.*`
 * - `\*` is treated as literal `*`
 * - `\\` is treated as literal `\`
 * - Matching is case-insensitive
 *
 * Uses null-byte sentinels to avoid replacement collisions.
 */
export function matchWildcardPattern(command: string, pattern: string): boolean {
  const re = compileWildcardPattern(pattern);
  return re ? re.test(command) : false;
}

function compileWildcardPattern(pattern: string): RegExp | null {
  // Step 1: replace escape sequences with sentinels
  let escaped = pattern
    .replace(/\\\\/g, ESCAPED_BACKSLASH_SENTINEL)
    .replace(/\\\*/g, ESCAPED_STAR_SENTINEL);

  // Step 2: escape regex-special chars (except our sentinels and *)
  escaped = escaped.replace(/[.+?^${}()|[\]]/g, '\\$&');

  // Step 3: replace unescaped * with .*
  escaped = escaped.replace(/\*/g, '.*');

  // Step 4: restore sentinels to literal characters
  escaped = escaped
    .replace(new RegExp(escapeRegExp(ESCAPED_STAR_SENTINEL), 'g'), '\\*')
    .replace(new RegExp(escapeRegExp(ESCAPED_BACKSLASH_SENTINEL), 'g'), '\\\\');

  try {
    return new RegExp(`^${escaped}$`, 'i');
  } catch {
    logger.warn(backgroundCtx(), `Invalid wildcard pattern, pattern=${pattern}`);
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check a single sub-command against a parsed ShellPermissionRule.
 */
export function matchShellRule(
  command: string,
  rule: ShellPermissionRule | CompiledShellPermissionRule,
): boolean {
  switch (rule.type) {
    case 'exact':
      return command === rule.command;
    case 'prefix':
      return command === rule.prefix || command.startsWith(`${rule.prefix} `);
    case 'argvPrefix':
      return matchArgvPrefix(command, rule.argv);
    case 'wildcard':
      if ('regex' in rule) {
        return rule.regex ? rule.regex.test(command) : false;
      }
      return matchWildcardPattern(command, rule.pattern);
  }
}

/**
 * Codex-aligned argv-prefix match: parse `command` into a single plain argv and
 * test whether `argv` is a token-wise prefix of it. Returns false when the
 * command is not a single word-only command (operators / substitutions /
 * redirects), so a stored prefix can never wave through a compound line.
 * Mirrors Codex matching a canonicalised argv against a stored prefix rule.
 */
function matchArgvPrefix(command: string, argv: readonly string[]): boolean {
  const commands = parseScriptPlainCommands(command);
  if (!commands || commands.length !== 1) return false;
  const target = commands[0]!;
  if (argv.length > target.length) return false;
  return argv.every((token, i) => token === target[i]);
}
