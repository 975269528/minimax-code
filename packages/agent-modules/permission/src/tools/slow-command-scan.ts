/**
 * Slow-command scanner — detects bash commands that recursively walk the
 * whole filesystem (or an entire home tree) and therefore can run for
 * minutes-to-hours, manifesting to the user as a "stuck" agent turn.
 *
 * This is a PERFORMANCE guard, not a SAFETY guard: the matched commands are
 * not dangerous, just wastefully unbounded. It lives next to the bash
 * permission checker because the permission `deny` verdict is the only point
 * on the OpenCode path that can BLOCK a tool before it executes (the
 * PreToolUse hook chain cannot — see bash-permission integration comment).
 *
 * Design rule — PREFER A MISS OVER A FALSE POSITIVE. We only flag the
 * unmistakable "scan from a top-level root with no depth bound" shapes.
 * Any explicit subdirectory, any `-maxdepth`, anything narrower → allowed
 * through. A wrongly-blocked legitimate command is far worse than letting an
 * occasional slow one through, so the matchers are deliberately strict.
 *
 * Cross-platform: matching is pure lexical analysis over the tokenised
 * command (via {@link shellTokenize}). We never touch the host filesystem or
 * spawn a process, so the same logic runs identically on macOS / Windows.
 */

import { shellTokenize } from './shell-tokenize.js';
import { splitCommand } from './bash-split.js';
import {
  consumeEnvVarPrefix,
  consumeShellWrapperPrefix,
  unwrapCommandWrappers,
} from './bash-wrapper-unwrap.js';

/** Result of a positive slow-command match. */
export interface SlowCommandMatch {
  /** Stable category tag surfaced on the permission decision reason. */
  category: 'slow-command';
  /**
   * Model-facing guidance describing why the command was blocked and what to
   * do instead. Embedded verbatim into the permission `deny` reason, which the
   * OpenCode plugin forwards to the model.
   */
  guidance: string;
}

/**
 * Top-level directories whose full recursive traversal is effectively a
 * whole-disk scan. Matched by EXACT path (after normalising a trailing
 * slash) — `find /var/log ...` is fine, only bare `find /var ...` trips.
 */
const HUGE_POSIX_ROOTS: ReadonlySet<string> = new Set([
  '/',
  '/Users',
  '/home',
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/var',
  '/opt',
  '/private',
]);

/** Strip a single trailing slash (but keep bare "/" intact). */
function normalizeRoot(p: string): string {
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) {
    return p.slice(0, -1);
  }
  return p;
}

/** Is this token the user's home directory (or its root), i.e. a huge scan? */
function isHomeRoot(token: string): boolean {
  const t = normalizeRoot(token);
  if (t === '~' || t === '$HOME' || t === '%USERPROFILE%') return true;
  // Braced forms `${HOME}` / `${USERPROFILE}` reach the permission gate
  // verbatim (we see the pre-expansion command text). A regex avoids the
  // `no-template-curly-in-string` lint a `'${HOME}'` literal would trip.
  return /^\$\{(HOME|USERPROFILE)\}$/.test(t);
}

/** Is this token a bare Windows drive root, e.g. `C:\`, `C:/`, `C:`? */
function isWindowsDriveRoot(token: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(token);
}

/** Does the token denote a top-level root whose full recursion = disk scan? */
function isHugeRoot(token: string): boolean {
  if (HUGE_POSIX_ROOTS.has(normalizeRoot(token))) return true;
  if (isHomeRoot(token)) return true;
  if (isWindowsDriveRoot(token)) return true;
  return false;
}

/** basename of argv[0], tolerant of an absolute path like `/usr/bin/find`. */
function commandBasename(arg0: string): string {
  const slash = Math.max(arg0.lastIndexOf('/'), arg0.lastIndexOf('\\'));
  return slash >= 0 ? arg0.slice(slash + 1) : arg0;
}

/**
 * `find [-H|-L|-P] [-D x] [-O n] <paths...> <expression>` — the start paths
 * are the leading operands after any global options, up to the first token
 * that looks like a primary/operator (`-name`, `-type`, `(`, `!`, …).
 *
 * GNU/BSD find accepts global options BEFORE the start paths (`find -L / …`).
 * If we stopped at the first `-` token we'd treat `-L` as the end of paths and
 * leave the list empty, missing a genuine whole-disk scan — so we consume the
 * known global options (and their values for `-D` / `-O`) first.
 *
 * Returns the list of path tokens (possibly empty → defaults to cwd, which we
 * do NOT treat as huge).
 */
function findStartPaths(args: string[]): string[] {
  let i = 0;
  // Consume leading global options.
  while (i < args.length) {
    const a = args[i] ?? '';
    if (a === '-H' || a === '-L' || a === '-P') {
      i++;
      continue;
    }
    if (a === '-D' || a === '-O') {
      // `-D debugopts` / `-O level` — GNU find global options that take a value
      // (also tolerate the glued `-O3` form, which has no separate token).
      i += a.length === 2 ? 2 : 1;
      continue;
    }
    break;
  }
  const paths: string[] = [];
  for (; i < args.length; i++) {
    const tok = args[i] ?? '';
    if (tok.startsWith('-') || tok === '(' || tok === '!' || tok === ')') break;
    paths.push(tok);
  }
  return paths;
}

/**
 * Does the arg list carry a real depth bound that makes `find` cheap?
 *
 * ONLY `-maxdepth` bounds recursion. `-depth` merely changes traversal ORDER
 * (process directory contents before the directory itself) — `find / -depth`
 * still walks the entire filesystem, so it must NOT be treated as bounded.
 */
function findHasDepthBound(args: string[]): boolean {
  return args.includes('-maxdepth');
}

/**
 * Does a `rg` (ripgrep) invocation carry a depth limit? ripgrep accepts
 * `--max-depth <n>` / `--max-depth=<n>` (and the `--maxdepth` spelling). A
 * bounded rg is not the unbounded whole-disk scan this guard targets.
 */
function rgHasDepthBound(args: string[]): boolean {
  return args.some(
    (a, i) =>
      a === '--max-depth' ||
      a === '--maxdepth' ||
      a.startsWith('--max-depth=') ||
      a.startsWith('--maxdepth=') ||
      ((args[i - 1] === '--max-depth' || args[i - 1] === '--maxdepth') && /^\d+$/.test(a)),
  );
}

/**
 * Does a `tree` invocation carry a recursion-depth limit (`-L <n>`,
 * `--level <n>`, `--level=<n>`)? A bounded tree is a cheap overview, not the
 * unbounded whole-disk walk this guard targets.
 */
function treeHasDepthBound(args: string[]): boolean {
  return args.some(
    (a, i) =>
      a === '-L' ||
      a === '--level' ||
      a.startsWith('--level=') ||
      // glued short form `-L2`
      /^-L\d+$/.test(a) ||
      // a bare numeric token immediately after `-L` / `--level` (already
      // covered by the flag check above, but keep the guard explicit)
      ((args[i - 1] === '-L' || args[i - 1] === '--level') && /^\d+$/.test(a)),
  );
}

/**
 * Does the `find` carry a DESTRUCTIVE action we should defer to the safety
 * classifier (rather than short-circuit as merely "slow")?
 *
 * `-delete` always qualifies. For the exec family (`-exec` / `-execdir` /
 * `-ok` / `-okdir`) only a DELETING payload qualifies (`rm` / `unlink` /
 * `rmdir`, optionally wrapped in `sh -c "… rm …"`). A read-only payload like
 * `find / -exec grep … {} \;` is NOT destructive — it is just an unbounded
 * whole-disk walk and must still trip the slow guard (it would otherwise be
 * fast-allowed downstream as a bare `find`). See Codex review P2-a.
 */
const DELETING_PAYLOAD_RE = /\b(rm|unlink|rmdir|shred)\b/;

function findHasDestructiveAction(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-delete') return true;
    if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
      // Scan the exec payload (everything up to the `;` / `+` terminator) for
      // a deleting command. If none, this exec is read-only → not destructive.
      for (let j = i + 1; j < args.length; j++) {
        const tok = args[j] ?? '';
        if (tok === ';' || tok === '\\;' || tok === '+') break;
        if (DELETING_PAYLOAD_RE.test(tok)) return true;
      }
    }
  }
  return false;
}

/**
 * Extract the PATH arguments of a `grep`/`rg`-style invocation, skipping the
 * search pattern. Grammar: `grep [flags] PATTERN [paths...]` — the first
 * bare (non-`-`) token is the pattern; everything after it is paths.
 *
 * Conservative by design (prefer a miss over a false positive):
 *   - Flags that take a SEPARATE value (`-e`, `-f`, `--regexp`, `--file`,
 *     `--include`, `--exclude`, `-m`, `-A`, `-B`, `-C`) consume the next
 *     token so it is not mistaken for the pattern.
 *   - If the pattern is supplied via `-e`/`-f`, the first bare token IS a
 *     path; we treat all bare tokens as paths in that case.
 *   - Anything ambiguous → we under-report paths, never over-report.
 */
const GREP_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-e',
  '-f',
  '-m',
  '-A',
  '-B',
  '-C',
  '-d',
  '-D',
  '--regexp',
  '--file',
  '--include',
  '--exclude',
  '--exclude-dir',
  '--include-dir',
  '--max-count',
  '--context',
  '--after-context',
  '--before-context',
]);

function grepPathArgs(args: string[]): string[] {
  let patternSeenViaFlag = false;
  let i = 0;
  // Walk leading flags; a value-flag consumes its argument.
  for (; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      i++;
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      // `-eFOO` / `--regexp=FOO` carry the pattern inline.
      if (a.startsWith('-e') && a.length > 2) patternSeenViaFlag = true;
      else if (a.startsWith('--regexp=') || a.startsWith('--file=')) patternSeenViaFlag = true;
      else if (GREP_VALUE_FLAGS.has(a)) {
        if (a === '-e' || a === '-f' || a === '--regexp' || a === '--file') {
          patternSeenViaFlag = true;
        }
        i++; // consume the flag's value token
      }
      continue;
    }
    break; // first bare token
  }
  // If the pattern already came from a flag, every remaining bare token is a
  // path. Otherwise the first bare token is the pattern → skip it.
  const rest = args.slice(i).filter((t) => !t.startsWith('-'));
  if (patternSeenViaFlag) return rest;
  return rest.slice(1);
}

/**
 * Inspect a single command segment (already separator-free) and return a
 * match when it is an unbounded whole-disk traversal.
 */
function inspectSegment(tokens: string[]): SlowCommandMatch | null {
  if (tokens.length === 0) return null;
  // Strip POSIX env-var prefixes first (`FOO=1 find /`, `env FOO=1 find /`,
  // `env -i grep -r x /`), THEN transparent wrappers (`nohup`, `timeout 3600`,
  // `setsid`, `nice`, `xargs`, `command`) so `nohup find /` /
  // `env -i find /` are seen as the inner `find /`. Both prefixes are exactly
  // how a long task gets launched/backgrounded, so they MUST be peeled or the
  // guard misses its main target (and, worse, the bare inner command would
  // fast-allow downstream and slip through even in bypass mode). `sudo` is
  // intentionally NOT stripped (privilege escalation) — it routes through the
  // safety classifier instead.
  // Loop so chained forms (`env FOO=1 nohup find /`) fully unwrap.
  let start = 0;
  for (;;) {
    const afterEnv = consumeEnvVarPrefix(tokens, start);
    const afterWrap = consumeShellWrapperPrefix(tokens, afterEnv);
    if (afterWrap === start) break;
    start = afterWrap;
  }
  const inner = tokens.slice(start);
  if (inner.length === 0) return null;
  const cmd = commandBasename(inner[0] ?? '');
  const args = inner.slice(1);

  // ── find: huge start path AND no depth bound AND no destructive action ─
  if (cmd === 'find') {
    if (findHasDepthBound(args)) return null;
    // Destructive find (-delete / -exec rm …) is a safety matter — defer to
    // the safety classifier so its irreversible-delete signal is preserved.
    if (findHasDestructiveAction(args)) return null;
    const startPaths = findStartPaths(args);
    if (startPaths.some(isHugeRoot)) {
      return slowMatch(
        `find from a top-level root (e.g. "/") with no -maxdepth walks the entire filesystem and can run for many minutes to hours`,
      );
    }
    return null;
  }

  // ── recursive grep / rg over a huge root ──────────────────────────────
  if (cmd === 'grep' || cmd === 'rg' || cmd === 'egrep' || cmd === 'fgrep') {
    // `rg` (ripgrep) recurses into directory arguments BY DEFAULT — `rg foo /`
    // walks the whole disk with no `-r`. grep/egrep/fgrep do NOT recurse
    // unless told to, so they still require an explicit recursive flag.
    // See Codex review P2-b.
    const isRipgrep = cmd === 'rg';
    const recursive =
      isRipgrep ||
      args.some(
        (a) =>
          a === '-r' ||
          a === '-R' ||
          a === '--recursive' ||
          (/^-[a-zA-Z]+$/.test(a) && (a.includes('r') || a.includes('R'))),
      );
    // A ripgrep depth limit (`--max-depth N` / `--max-depth=N`, also the
    // `--maxdepth` spelling) bounds the walk — a bounded search is not the
    // unbounded whole-disk scan this guard targets, so let it through.
    if (isRipgrep && rgHasDepthBound(args)) return null;
    // Only the PATH args can be a huge root — NOT the search pattern. For
    // `grep [flags] PATTERN [paths...]` the first non-flag token is the
    // pattern (e.g. `grep -r '/' .` searches for the literal slash in cwd and
    // must NOT trip), so we skip it before scanning for roots.
    if (recursive && grepPathArgs(args).some(isHugeRoot)) {
      return slowMatch(
        `recursive ${cmd} over a top-level root scans the whole filesystem; rg/grep over "/" rarely terminates in a useful time`,
      );
    }
    return null;
  }

  // ── du over a huge root (du recurses by default) ──────────────────────
  if (cmd === 'du') {
    if (args.some(isHugeRoot)) {
      return slowMatch(
        `du over a top-level root sums every file on the disk and can hang for a very long time`,
      );
    }
    return null;
  }

  // ── ls -R over a huge root ────────────────────────────────────────────
  if (cmd === 'ls') {
    const recursive = args.some((a) => a === '-R' || (/^-[a-zA-Z]+$/.test(a) && a.includes('R')));
    if (recursive && args.some(isHugeRoot)) {
      return slowMatch(`ls -R over a top-level root lists the entire filesystem tree`);
    }
    return null;
  }

  // ── tree over a huge root (recurses by default) ───────────────────────
  if (cmd === 'tree') {
    // `-L <n>` / `--level <n>` / `--level=<n>` bound tree's recursion depth,
    // making `tree -L 1 /` a cheap top-level overview — not the unbounded
    // whole-disk walk this guard targets.
    if (treeHasDepthBound(args)) return null;
    if (args.some(isHugeRoot)) {
      return slowMatch(`tree over a top-level root walks the entire filesystem`);
    }
    return null;
  }

  // ── Windows: dir /s <drive-root> ──────────────────────────────────────
  if (cmd.toLowerCase() === 'dir') {
    const recursive = args.some((a) => a.toLowerCase() === '/s');
    if (recursive && args.some(isHugeRoot)) {
      return slowMatch(
        `dir /s from a drive root walks the entire drive and can take a very long time`,
      );
    }
    return null;
  }

  // ── Windows PowerShell: Get-ChildItem -Recurse <drive-root> ───────────
  const lower = cmd.toLowerCase();
  if (lower === 'get-childitem' || lower === 'gci' || lower === 'ls.exe' || lower === 'dir.exe') {
    const recursive = args.some((a) => {
      const al = a.toLowerCase();
      return al === '-recurse' || al === '-r';
    });
    if (recursive && args.some(isHugeRoot)) {
      return slowMatch(
        `Get-ChildItem -Recurse from a drive root enumerates the entire drive and can hang for a long time`,
      );
    }
    return null;
  }

  return null;
}

/** Build a full guidance message from the per-command "why" clause. */
function slowMatch(why: string): SlowCommandMatch {
  return {
    category: 'slow-command',
    guidance:
      `This command was blocked because ${why}. ` +
      `Running it would very likely stall the turn. ` +
      `Do NOT retry it as-is. Instead, narrow the scope: target a specific ` +
      `subdirectory rather than a top-level root, add a depth bound ` +
      `(e.g. \`find <dir> -maxdepth 3\`), filter early (\`-name\` / \`-type\` / a ` +
      `tighter pattern), or use a faster purpose-built tool such as \`rg\` ` +
      `(ripgrep) for content search or \`fd\` for filename search.`,
  };
}

/**
 * Scan a full bash command line (which may chain several segments with
 * `&&` / `||` / `;` / `|`) and return the first unbounded whole-disk
 * traversal found, or `null` when none match.
 *
 * Segmentation reuses {@link splitCommand} — the same separator splitter the
 * permission gate uses — so glued operators (`a;b`), pipes, and heredoc
 * bodies are handled consistently with the rest of the bash checker.
 *
 * Also unwraps `bash -c "<payload>"` / `sh -c "<payload>"` (and wrapper-
 * prefixed forms) via {@link unwrapCommandWrappers} so a wrapped whole-disk
 * scan (`bash -c "find / -name x"`) is caught too — otherwise it would be
 * invisible here and slip through the bypass early-exit. See Codex review.
 */
export function detectSlowCommand(command: string): SlowCommandMatch | null {
  if (!command || typeof command !== 'string') return null;
  // Each candidate is the original command plus any `bash -c` inner payloads.
  for (const candidate of unwrapCommandWrappers(command)) {
    for (const segment of splitCommand(candidate)) {
      const tokens = shellTokenize(segment);
      const hit = inspectSegment(tokens);
      if (hit) return hit;
    }
  }
  return null;
}
