/**
 * Session-scoped registry of files that the agent has successfully written
 * during the current session.
 *
 * Purpose
 * -------
 *
 * When an agent writes a script (Write/Edit tool returns `allow`) and then
 * tries to execute it (e.g. `bash /tmp/foo.sh`, `bash $WORKSPACE/run.sh`),
 * we want to skip the SOFT remote-execution ASK that would otherwise
 * misclassify the local script as a piped-shell payload.
 *
 * Scope
 * -----
 *
 * - Keyed by session id; cleared via {@link clearSession} when the session
 *   ends (the bridge calls this in its `SessionEnd` path).
 * - In-memory only — agents that write before a daemon restart will not
 *   benefit, but daemon restart implies new session ids anyway, so the
 *   registry is rebuilt as the new session writes.
 * - Cross-platform absolute path normalization (`path.resolve`) before
 *   storage and lookup so `/tmp/a/../b/x.sh` and `/tmp/b/x.sh` match.
 *
 * Safety
 * ------
 *
 * The registry is consulted ONLY by the bash SOFT remote-execution pre-scan
 * inside `bash-permission.ts`. It does not override:
 *   - HARD-blocked operations (catastrophic-standalone, sensitive-read,
 *     irrecoverable-delete, etc.)
 *   - explicit user `deny` rules
 *   - per-subcommand safety checks downstream of the pre-scan
 *
 * Concretely, even if a session previously wrote `/tmp/x.sh`, a command like
 * `rm -rf / && bash /tmp/x.sh` is still DENIED by the catastrophic-standalone
 * gate at the top of `checkBashPermission`, and a `curl ... | bash` still
 * trips the pipe-to-shell HARD pattern. The registry only saves the user
 * from one specific false positive: `<sep> bash <local-script>`.
 */

import path from 'node:path';
import { logger, backgroundCtx } from './host-utils.js';

const registry = new Map<string, Set<string>>();

/**
 * Record that the given absolute path was written by this session.
 *
 * Called by the fs permission checker after a Write/Edit tool returns
 * `allow` (regardless of which allow branch — workingDirectory,
 * tempDirectory, sandbox, or rule).
 */
export function recordWrite(sessionId: string, absPath: string): void {
  if (!sessionId || !absPath) return;
  const resolved = path.resolve(absPath);
  let set = registry.get(sessionId);
  if (!set) {
    set = new Set<string>();
    registry.set(sessionId, set);
  }
  if (!set.has(resolved)) {
    set.add(resolved);
    logger.debug(
      backgroundCtx(),
      `[written-files] recorded sessionId=${sessionId} path=${resolved} total=${set.size}`,
    );
  }
}

/**
 * Returns true if the session previously wrote this exact absolute path.
 */
export function hasWritten(sessionId: string | undefined, absPath: string): boolean {
  if (!sessionId || !absPath) return false;
  const set = registry.get(sessionId);
  if (!set) return false;
  return set.has(path.resolve(absPath));
}

/**
 * Drop the registry for a session. Called from session lifecycle on
 * SessionEnd so the registry doesn't leak forever.
 */
export function clearSession(sessionId: string): void {
  if (!sessionId) return;
  const had = registry.delete(sessionId);
  if (had) {
    logger.debug(backgroundCtx(), `[written-files] cleared sessionId=${sessionId}`);
  }
}

/**
 * Test-only: wipe all entries.
 */
export function _resetForTests(): void {
  registry.clear();
}

/**
 * Test-only: snapshot of a session's set for assertions.
 */
export function _snapshotForTests(sessionId: string): string[] {
  const set = registry.get(sessionId);
  return set ? [...set].sort() : [];
}
