import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Options for {@link createDiskLogTransport}. The transport writes UTF-8 log
 * text to a rotating file inside `dir`, and enforces both a hard retention
 * cutoff and a total-bytes budget so the on-disk footprint stays bounded on
 * long-running user machines.
 *
 * Design mirrors the Electron main-process file logger
 * (`apps/electron/main/utils/logger.ts`) — same fire-and-forget append via a
 * per-file promise chain, same "retention sweep is best-effort" invariant —
 * but with two policy differences:
 *
 * 1. **Rotation cadence is per hour, not per day.** Local-runtime and CLI
 *    embedded runtimes produce >100k lines per active hour on a busy dev
 *    machine; a per-day file makes tail/grep painful and forces the upload
 *    bundle to pick either the whole day or nothing. Per-hour aligns with
 *    the existing `runtime-\d{10}\.log` (YYYYMMDDHH) pattern that the
 *    Electron feedback bundle and CLI diagnostics command already scan.
 * 2. **A total-bytes cap is enforced.** The Electron logger relies purely on
 *    the 7-day age cutoff. That's fine for a UI process that logs O(1MB/day),
 *    but the local runtime can burst well past 512MB in a single busy day
 *    (SSE turns, MCP chatter, ND audit). Without a total cap, one bad day
 *    would evict nothing until the next daily sweep.
 */
export interface DiskLogTransportOptions {
  /**
   * Absolute path of the directory to write log files into. Created on first
   * write with `recursive: true`; if the directory cannot be created every
   * subsequent write surfaces the error via {@link DiskLogTransportOptions.onError}
   * without throwing to the caller.
   */
  dir: string;
  /**
   * Filename prefix. The final on-disk name is
   * `<prefix>-<YYYYMMDDHH>.log` (or `<prefix>-<YYYYMMDDHH>.<part>.log` when
   * a single hour exceeds {@link maxBytesPerFile}). Defaults to `runtime` so
   * the output matches the `runtime-\d{10}(?:\.\d+)?\.log` pattern the
   * Electron feedback bundle scanner already recognises.
   */
  prefix?: string;
  /**
   * Soft cap on a single file's bytes. When the current hour's file would
   * exceed this, the transport rolls over to `.1.log`, `.2.log`, ... within
   * the same hour bucket. A single log line that is by itself larger than
   * the cap is written unsplit — losing a whole line is worse than a
   * slightly oversized file.
   *
   * Defaults to 50 MiB. Matches the per-file tail cap the upload bundle
   * applies (`RUNTIME_LOG_TAIL_BYTES = 20 * 1024 * 1024`) with 2.5× headroom
   * so a whole hour still typically fits in one file.
   */
  maxBytesPerFile?: number;
  /**
   * Hard cap on total bytes across all `<prefix>-*.log` files in `dir`. When
   * a rotation triggers the retention sweep and the sum exceeds this cap,
   * the oldest files are unlinked until the sum is ≤ the cap. Defaults to
   * 512 MiB — same order of magnitude as the upload zip cap so we never
   * silently accumulate more than the user could actually ship in a
   * feedback bundle.
   */
  maxTotalBytes?: number;
  /**
   * Hard cutoff by mtime. Files older than `now - retentionMs` are deleted
   * on the next retention sweep. Defaults to 7 days to match the Electron
   * main-process log cleanup (`cleanupOldLogs` in `utils/logger.ts`).
   */
  retentionMs?: number;
  /**
   * Clock hook — the transport calls this exactly once per {@link write}
   * (to compute the current hour bucket) and once per sweep (to compute the
   * retention cutoff). Tests inject a mutable clock to exercise rotation
   * without waiting for real time. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Error sink for background IO failures. The transport intentionally does
   * not throw from {@link DiskLogTransport.write} — losing a log line is
   * preferable to breaking the caller — so all disk failures (mkdir,
   * appendFile, unlink) route here. Defaults to a no-op.
   */
  onError?: (err: Error) => void;
}

/**
 * Handle returned by {@link createDiskLogTransport}. The caller owns the
 * lifecycle: it must call {@link close} on shutdown, and can call
 * {@link flush} before uploading logs to ensure pending writes have landed.
 */
export interface DiskLogTransport {
  /**
   * Enqueue a chunk of text for asynchronous append. Non-blocking; the
   * caller can invoke this from a synchronous pino/pino-pretty stream
   * callback without introducing back-pressure into the logging path.
   *
   * All writes to the same transport are serialised through a single
   * promise chain, so lines appear in the order they were submitted.
   */
  write(text: string): void;
  /**
   * Wait until every previously-submitted {@link write} has finished. Safe
   * to call from a feedback-upload code path before the bundle zip is
   * sealed.
   */
  flush(): Promise<void>;
  /**
   * Flush pending writes, run one final retention sweep, and stop accepting
   * new writes. Idempotent. After `close()` resolves any subsequent
   * {@link write} is silently dropped.
   */
  close(): Promise<void>;
  /**
   * Absolute path of the file the next write would append to, or `null`
   * before the first write has picked an hour bucket. Exposed for tests
   * and diagnostics — production callers should not depend on this.
   */
  getCurrentFilePath(): string | null;
}

const DEFAULT_MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface RotationState {
  hourKey: string | null;
  partIndex: number;
  currentPath: string | null;
  currentSize: number;
}

/**
 * Build an hourly-rotating file transport with retention + total-bytes cap.
 *
 * Ownership contract: the caller (typically a runtime host wiring block)
 * owns the returned handle and must call {@link DiskLogTransport.close} on
 * shutdown. The transport does NOT install any process-level exit hooks —
 * that is a host concern.
 */
export function createDiskLogTransport(opts: DiskLogTransportOptions): DiskLogTransport {
  const dir = opts.dir;
  const prefix = opts.prefix ?? 'runtime';
  const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = opts.now ?? Date.now;
  const onError = opts.onError ?? (() => {});

  if (prefix.length === 0 || /[/\\]/.test(prefix)) {
    throw new Error(`createDiskLogTransport: invalid prefix ${JSON.stringify(prefix)}`);
  }
  if (maxBytesPerFile <= 0 || maxTotalBytes <= 0 || retentionMs <= 0) {
    throw new Error(
      'createDiskLogTransport: maxBytesPerFile, maxTotalBytes, retentionMs must be > 0',
    );
  }

  const state: RotationState = {
    hourKey: null,
    partIndex: 0,
    currentPath: null,
    currentSize: 0,
  };

  let writeChain: Promise<void> = Promise.resolve();
  let dirEnsured = false;
  let closed = false;
  let sweepInFlight = false;
  let sweepQueued = false;

  const filenameFor = (hourKey: string, part: number): string =>
    part === 0 ? `${prefix}-${hourKey}.log` : `${prefix}-${hourKey}.${part}.log`;

  const ensureDir = async (): Promise<void> => {
    if (dirEnsured) return;
    await fsp.mkdir(dir, { recursive: true });
    dirEnsured = true;
  };

  const rotateFor = async (byteLen: number): Promise<boolean> => {
    const hourKey = formatHourKey(now());
    if (hourKey !== state.hourKey) {
      state.hourKey = hourKey;
      state.partIndex = 0;
      state.currentPath = path.join(dir, filenameFor(hourKey, 0));
      state.currentSize = await statSizeOr0(state.currentPath);
      scheduleSweep();
    }
    // Roll to `.N.log` inside the same hour bucket if the write would push
    // us past maxBytesPerFile. Skip when `currentSize === 0` so a single
    // oversized log line still lands somewhere instead of triggering an
    // infinite roll loop.
    let rolledIntraHour = false;
    while (state.currentSize > 0 && state.currentSize + byteLen > maxBytesPerFile) {
      state.partIndex += 1;
      state.currentPath = path.join(dir, filenameFor(state.hourKey, state.partIndex));
      state.currentSize = await statSizeOr0(state.currentPath);
      rolledIntraHour = true;
    }
    return rolledIntraHour;
  };

  const doWrite = async (text: string): Promise<void> => {
    // Do NOT short-circuit on `closed` here — writes that were enqueued
    // before `close()` swapped the flag must still land, otherwise the
    // close+await pattern would silently drop the last few lines.
    const buf = Buffer.from(text, 'utf8');
    try {
      await ensureDir();
    } catch (err) {
      onError(err as Error);
      return;
    }
    let rolledIntraHour = false;
    try {
      rolledIntraHour = await rotateFor(buf.byteLength);
    } catch (err) {
      onError(err as Error);
      return;
    }
    if (!state.currentPath) return;
    try {
      await fsp.appendFile(state.currentPath, buf);
      state.currentSize += buf.byteLength;
      // Intra-hour rollover is exactly the case where a single hour is on
      // track to blow past `maxTotalBytes` — a busy hour can produce many
      // `.N.log` shards before the natural hour-boundary sweep. Kick the
      // sweep after the new shard is written so the total-bytes cap sees the
      // shard that caused the rollover. (Codex Review P2 on MR !3981.)
      if (rolledIntraHour) {
        scheduleSweep();
      }
    } catch (err) {
      onError(err as Error);
    }
  };

  const scheduleSweep = (): void => {
    if (sweepInFlight) {
      sweepQueued = true;
      return;
    }
    sweepInFlight = true;
    // Detach from the write chain so a slow sweep never delays a log line.
    // Uses queueMicrotask so tests that await flush() also see the sweep
    // complete synchronously via close()'s runFinalSweep step.
    void Promise.resolve()
      .then(() => runRetentionSweep({ dir, prefix, maxTotalBytes, retentionMs, now, onError }))
      .catch((err) => onError(err as Error))
      .finally(() => {
        sweepInFlight = false;
        if (sweepQueued) {
          sweepQueued = false;
          scheduleSweep();
        }
      });
  };

  const write = (text: string): void => {
    if (closed) return;
    writeChain = writeChain
      .then(() => doWrite(text))
      .catch((err) => {
        onError(err as Error);
      });
  };

  const flush = async (): Promise<void> => {
    // Snapshot the chain locally so writes issued during the await don't
    // extend the flush indefinitely.
    const pending = writeChain;
    await pending;
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await writeChain;
    } catch {
      // errors already routed via onError inside the chain
    }
    // Wait for any in-flight background sweep before running the final one,
    // so the final result is deterministic for tests.
    await waitFor(() => !sweepInFlight);
    try {
      await runRetentionSweep({ dir, prefix, maxTotalBytes, retentionMs, now, onError });
    } catch (err) {
      onError(err as Error);
    }
  };

  return {
    write,
    flush,
    close,
    getCurrentFilePath: () => state.currentPath,
  };
}

/**
 * Format an epoch-ms timestamp as `YYYYMMDDHH` in the local timezone. Local
 * TZ matches the Electron main-process file logger (`getDateString()`),
 * which uses the user's wall-clock time so the filename lines up with what
 * they see in the UI when they trigger a feedback upload.
 */
export function formatHourKey(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  const hh = d.getHours().toString().padStart(2, '0');
  return `${y}${m}${day}${hh}`;
}

async function statSizeOr0(p: string): Promise<number> {
  try {
    const stat = await fsp.stat(p);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function waitFor(pred: () => boolean, tries = 50, delayMs = 5): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
}

interface SweepOptions {
  dir: string;
  prefix: string;
  maxTotalBytes: number;
  retentionMs: number;
  now: () => number;
  onError: (err: Error) => void;
}

/**
 * Enforce retention (mtime cutoff) and total-bytes cap on the log directory.
 *
 * Sweep is best-effort: individual unlink errors are surfaced via `onError`
 * and skipped; a `readdir` failure is treated as "directory does not exist
 * yet" (typical before the very first write) and returns silently.
 */
async function runRetentionSweep(opts: SweepOptions): Promise<void> {
  const { dir, prefix, maxTotalBytes, retentionMs, now, onError } = opts;
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  const pattern = new RegExp(`^${escapeRegex(prefix)}-\\d{10}(?:\\.\\d+)?\\.log$`);
  const cutoff = now() - retentionMs;

  interface Entry {
    path: string;
    size: number;
    mtimeMs: number;
    live: boolean;
  }

  const stats: Entry[] = [];
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const filePath = path.join(dir, name);
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) continue;
      stats.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, live: true });
    } catch {
      // Skip individual failures
    }
  }

  // 1) mtime retention
  for (const e of stats) {
    if (e.mtimeMs < cutoff) {
      try {
        await fsp.unlink(e.path);
        e.live = false;
      } catch (err) {
        onError(err as Error);
      }
    }
  }

  // 2) total-bytes cap — evict oldest until under budget. Keep at least the
  //    newest file even if it alone exceeds the cap, so the transport can
  //    still land the current hour's writes.
  const remaining = stats
    .filter((e) => e.live)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || compareLogPaths(a.path, b.path));
  let total = remaining.reduce((sum, e) => sum + e.size, 0);
  for (let i = 0; i < remaining.length - 1 && total > maxTotalBytes; i += 1) {
    const e = remaining[i];
    if (!e) continue;
    try {
      await fsp.unlink(e.path);
      total -= e.size;
    } catch (err) {
      onError(err as Error);
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareLogPaths(a: string, b: string): number {
  const ap = parseLogPath(path.basename(a));
  const bp = parseLogPath(path.basename(b));
  if (!ap || !bp) return path.basename(a).localeCompare(path.basename(b));
  return ap.hourKey.localeCompare(bp.hourKey) || ap.partIndex - bp.partIndex;
}

function parseLogPath(name: string): { hourKey: string; partIndex: number } | null {
  const match = /-(\d{10})(?:\.(\d+))?\.log$/.exec(name);
  if (!match) return null;
  const hourKey = match[1];
  if (!hourKey) return null;
  return { hourKey, partIndex: match[2] ? Number(match[2]) : 0 };
}
