/**
 * Seed the `mavis-trash` script into `<dataDir>/bin/`. Called once during
 * `LocalRuntimeApiHost` startup so the bash-permission `rm → mavis-trash`
 * rewrite has an actual executable to spawn.
 *
 * Ported from the retired daemon package (`packages/daemon/src/server.ts:
 * ensureTrashScript`, deleted by commit 99ccaca02 "chore(local-runtime):
 * retire daemon package"). The pi-agent refactor dropped this seeding
 * step, leaving the rewrite target missing so agent `rm` invocations
 * failed with `mavis-trash: No such file or directory` and the model
 * fell back to `/bin/rm` — hard-deleting the user's files.
 *
 * - macOS / Linux: seeds a POSIX bash script at `mavis-trash` (0o755).
 * - Windows: seeds a Node.js script at `mavis-trash.js` plus a `.cmd`
 *   launcher `mavis-trash.cmd`, so the permission pipeline can invoke
 *   `mavis-trash <paths>` uniformly across platforms.
 *
 * Idempotent: only rewrites when the on-disk content differs from the
 * bundled string (so restarts don't churn the file mtime).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { TRASH_SCRIPT_CONTENT } from './trash-script.js';
import { TRASH_CMD_LAUNCHER_CONTENT, TRASH_SCRIPT_WIN_CONTENT } from './trash-script-win.js';

export function ensureTrashScript(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const binDir = path.join(dataDir, 'bin');
  mkdirSync(binDir, { recursive: true });

  const isWin = platform === 'win32';

  if (isWin) {
    seedFileIfChanged(path.join(binDir, 'mavis-trash.js'), TRASH_SCRIPT_WIN_CONTENT);
    seedFileIfChanged(path.join(binDir, 'mavis-trash.cmd'), TRASH_CMD_LAUNCHER_CONTENT);
  } else {
    seedFileIfChanged(path.join(binDir, 'mavis-trash'), TRASH_SCRIPT_CONTENT, 0o755);
  }
  // Any change to the on-disk launcher invalidates the previous probe cache;
  // otherwise a stale cached "available: true" could survive an overwrite.
  clearTrashRuntimeCache();
}

/**
 * Cache of the last `inspectTrashRuntime` verdict keyed by dataDir plus the
 * SHA-256 of the launcher pair contents. The permission facade calls
 * `inspectTrashRuntime` on every delete-like permission decision; without
 * a cache each call reads both files and (on Windows) spawns cmd.exe with
 * a 5 s timeout — the hot-path performance concern flagged during MR review.
 *
 * The cache key is the content hash, NOT mtime, so a tamper that overwrites
 * the launcher while restoring its original mtime (`utimes` /
 * `touch -r other-file`) cannot reuse the previous "available: true"
 * verdict for a replaced launcher. The trade-off is that every call still
 * reads both files, but skips the expensive cmd.exe spawn probe when the
 * bytes are identical to what we last saw.
 */
type TrashRuntimeCacheEntry = {
  readonly scriptHash: string;
  readonly launcherHash: string;
  readonly verdict: TrashRuntimeStatus;
};
const trashRuntimeCache = new Map<string, TrashRuntimeCacheEntry>();

export type TrashRuntimeDiagnostics = {
  readonly phase: 'read-script' | 'read-launcher' | 'verify-content' | 'probe';
  readonly failure:
    | 'read-failed'
    | 'content-mismatch'
    | 'spawn-failed'
    | 'timed-out'
    | 'unexpected-exit'
    | 'unexpected-output'
    | 'probe-rejected';
  readonly component?: 'script' | 'launcher';
  readonly error_code?: string;
  readonly syscall?: string;
  readonly script_matches_bundled?: boolean;
  readonly launcher_matches_bundled?: boolean;
  readonly command_interpreter_source?: 'ComSpec' | 'default';
  readonly command_interpreter_basename?: string;
  readonly runtime_kind?: 'electron' | 'node';
  readonly runtime_executable_basename?: string;
  readonly duration_ms?: number;
  readonly exit_status?: number | null;
  readonly signal?: string | null;
  readonly expected_stderr_marker_found?: boolean;
  readonly stderr_preview?: string;
};

export type TrashRuntimeStatus =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: string;
      readonly diagnostics?: TrashRuntimeDiagnostics;
    };

type TrashProbeResult =
  | { readonly callable: true }
  | { readonly callable: false; readonly diagnostics: TrashRuntimeDiagnostics };

export function clearTrashRuntimeCache(): void {
  trashRuntimeCache.clear();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function inspectTrashRuntime(
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  probe?: (scriptPath: string, launcherPath: string) => boolean,
): TrashRuntimeStatus {
  if (platform === 'darwin' || platform === 'linux') {
    const scriptPath = path.join(dataDir, 'bin', 'mavis-trash');
    const cacheKey = `${platform}:${dataDir}`;
    try {
      const scriptContent = readFileSync(scriptPath, 'utf8');
      const scriptHash = sha256(scriptContent);
      const launcherHash = 'posix-no-launcher';
      if (scriptContent !== TRASH_SCRIPT_CONTENT) {
        const verdict = { available: false, reason: 'mavis-trash files are stale' } as const;
        trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
        return verdict;
      }
      if ((statSync(scriptPath).mode & 0o111) === 0) {
        // Do not cache mode failures: ensureTrashScript may repair the execute
        // bit without changing the content hash on the next tick.
        return { available: false, reason: 'mavis-trash is not executable' };
      }
      const cached = trashRuntimeCache.get(cacheKey);
      if (cached && cached.scriptHash === scriptHash && cached.launcherHash === launcherHash) {
        return cached.verdict;
      }
      // Unlike the Windows .cmd launcher, POSIX execution uses /bin/bash with
      // the exact verified script bytes, so no separate spawn probe is needed.
      const verdict = { available: true } as const;
      trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
      return verdict;
    } catch (error) {
      // Never cache filesystem failures; startup may re-seed the file next.
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (platform !== 'win32') return { available: true };
  const scriptPath = path.join(dataDir, 'bin', 'mavis-trash.js');
  const launcherPath = path.join(dataDir, 'bin', 'mavis-trash.cmd');
  const cacheKey = `${platform}:${dataDir}`;
  let phase: TrashRuntimeDiagnostics['phase'] = 'read-script';
  try {
    // Always re-read both files. If a caller restored the mtime after
    // rewriting the launcher, the mtime would still lie about staleness;
    // hashing the actual bytes is the only tamper-resistant cache key.
    const scriptContent = readFileSync(scriptPath, 'utf8');
    phase = 'read-launcher';
    const launcherContent = readFileSync(launcherPath, 'utf8');
    phase = 'verify-content';
    const scriptHash = sha256(scriptContent);
    const launcherHash = sha256(launcherContent);
    const cached = trashRuntimeCache.get(cacheKey);
    if (cached && cached.scriptHash === scriptHash && cached.launcherHash === launcherHash) {
      return cached.verdict;
    }
    const scriptMatchesBundled = scriptContent === TRASH_SCRIPT_WIN_CONTENT;
    const launcherMatchesBundled = launcherContent === TRASH_CMD_LAUNCHER_CONTENT;
    if (!scriptMatchesBundled || !launcherMatchesBundled) {
      const verdict: TrashRuntimeStatus = {
        available: false,
        reason: 'mavis-trash files are stale',
        diagnostics: {
          phase: 'verify-content',
          failure: 'content-mismatch',
          script_matches_bundled: scriptMatchesBundled,
          launcher_matches_bundled: launcherMatchesBundled,
        },
      };
      trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
      return verdict;
    }
    phase = 'probe';
    const probeResult: TrashProbeResult = probe
      ? probe(scriptPath, launcherPath)
        ? { callable: true }
        : {
            callable: false,
            diagnostics: { phase: 'probe', failure: 'probe-rejected' },
          }
      : probeTrashScript(launcherPath);
    const verdict: TrashRuntimeStatus = probeResult.callable
      ? { available: true }
      : {
          available: false,
          reason: 'mavis-trash is not callable',
          diagnostics: probeResult.diagnostics,
        };
    trashRuntimeCache.set(cacheKey, { scriptHash, launcherHash, verdict });
    return verdict;
  } catch (error) {
    // Never cache a filesystem-error verdict — the missing file may reappear
    // on the next tick after ensureTrashScript re-seeds.
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      diagnostics: {
        phase,
        failure: 'read-failed',
        component: phase === 'read-script' ? 'script' : 'launcher',
        ...readNodeErrorDiagnostics(error),
      },
    };
  }
}

function probeTrashScript(launcherPath: string): TrashProbeResult {
  const commandInterpreter = process.env.ComSpec || 'cmd.exe';
  const startedAt = Date.now();
  const result = spawnSync(
    commandInterpreter,
    ['/d', '/s', '/c', `call "${launcherPath.replaceAll('"', '""')}" --`],
    {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      // The final argv entry is already a complete cmd.exe `/c` payload.
      // Node's default Windows quoting escapes its embedded quotes as `\"`,
      // which cmd.exe treats as literal characters instead of launcher quotes.
      windowsVerbatimArguments: true,
    },
  );
  const durationMs = Date.now() - startedAt;
  const stderr = result.stderr ?? '';
  const stderrMarkerFound = stderr.includes('no files specified');
  if (!result.error && result.status === 1 && stderrMarkerFound) return { callable: true };

  const errorCode = readErrorString(result.error, 'code');
  const failure: TrashRuntimeDiagnostics['failure'] = result.error
    ? errorCode === 'ETIMEDOUT'
      ? 'timed-out'
      : 'spawn-failed'
    : result.status !== 1
      ? 'unexpected-exit'
      : 'unexpected-output';
  return {
    callable: false,
    diagnostics: {
      phase: 'probe',
      failure,
      command_interpreter_source: process.env.ComSpec ? 'ComSpec' : 'default',
      command_interpreter_basename: path.win32.basename(commandInterpreter),
      runtime_kind: process.versions.electron ? 'electron' : 'node',
      runtime_executable_basename: path.win32.basename(process.execPath),
      duration_ms: durationMs,
      exit_status: result.status,
      signal: result.signal,
      expected_stderr_marker_found: stderrMarkerFound,
      ...(errorCode ? { error_code: errorCode } : {}),
      ...readNodeErrorDiagnostics(result.error),
      ...probeOutputDiagnostics(stderr, launcherPath),
    },
  };
}

function readNodeErrorDiagnostics(
  error: unknown,
): Pick<TrashRuntimeDiagnostics, 'error_code' | 'syscall'> {
  return {
    ...(readErrorString(error, 'code') ? { error_code: readErrorString(error, 'code') } : {}),
    ...(readErrorString(error, 'syscall') ? { syscall: readErrorString(error, 'syscall') } : {}),
  };
}

function readErrorString(error: unknown, key: 'code' | 'syscall'): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = Reflect.get(error, key);
  return typeof value === 'string' && value ? value : undefined;
}

function probeOutputDiagnostics(
  stderr: string,
  launcherPath: string,
): Pick<TrashRuntimeDiagnostics, 'stderr_preview'> {
  const sanitize = (value: string): string | undefined => {
    const preview = value
      .replaceAll(launcherPath, '<launcher>')
      .replaceAll(path.dirname(launcherPath), '<runtime-bin>')
      .replaceAll(process.execPath, '<runtime-executable>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 512);
    return preview || undefined;
  };
  const stderrPreview = sanitize(stderr);
  return {
    ...(stderrPreview ? { stderr_preview: stderrPreview } : {}),
  };
}

/** Write `content` to `filePath` only when the file is missing or stale. */
function seedFileIfChanged(filePath: string, content: string, mode?: number): void {
  let needsWrite = true;
  if (existsSync(filePath)) {
    try {
      if (readFileSync(filePath, 'utf-8') === content) needsWrite = false;
    } catch {
      // Can't read — overwrite.
    }
  }
  if (!needsWrite) {
    if (mode !== undefined && (statSync(filePath).mode & 0o111) === 0) {
      chmodSync(filePath, mode);
    }
    return;
  }
  writeFileSync(filePath, content, mode !== undefined ? { mode } : undefined);
}
