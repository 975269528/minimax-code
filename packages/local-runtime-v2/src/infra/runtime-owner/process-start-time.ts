import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_000;
const LINUX_PROC_STAT_STARTTIME_INDEX = 19;
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const DARWIN_LSTART_PATTERN = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/u;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The start instant of one process, or the reason this platform could not report it.
 *
 * `token` exists only to disambiguate a reused PID: a Runtime owner lease records the
 * token of its writer, and a later reader treats a mismatch as proof that the recorded
 * owner is gone. A missing token therefore has to stay a *degrade* signal that falls
 * back to bare-PID liveness — never an error, because a platform without a probe still
 * has to boot. `unavailable` is returned instead of being logged here so the caller can
 * report it together with the lease that degraded.
 */
export interface ProcessStartProbe {
  readonly token?: string;
  readonly unavailable?: string;
}

/**
 * Reads a comparable start-instant token for `pid`.
 *
 * Tokens are namespaced by platform and pinned to an absolute instant so that they never
 * change while the process lives: Linux ticks-since-boot are only meaningful within one
 * boot and are therefore prefixed with the boot id, and the macOS probe forces
 * `TZ=UTC`/`LC_ALL=C` because `ps -o lstart=` prints localized wall-clock text — a
 * timezone, DST or locale change would otherwise make a living process look replaced and
 * silently weaken the owner fence.
 *
 * Never throws: every failure degrades to `{ unavailable }`.
 */
export async function readProcessStartToken(pid: number): Promise<ProcessStartProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { unavailable: 'invalid-pid' };
  try {
    if (process.platform === 'linux') return await readLinuxStartProbe(pid);
    if (process.platform === 'darwin') return await readDarwinStartProbe(pid);
    // Windows exposes start times through GetProcessTimes only, which needs a native
    // binding this package does not ship; spawning PowerShell on every lease check would
    // cost more boot latency than the PID-reuse risk it removes.
    return { unavailable: `unsupported-platform:${process.platform}` };
  } catch (error) {
    // A dead PID, an unreadable /proc entry or a missing `ps` must not decide liveness.
    return { unavailable: `probe-failed:${errorCode(error) ?? 'UNKNOWN'}` };
  }
}

async function readLinuxStartProbe(pid: number): Promise<ProcessStartProbe> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, 'utf8');
  // The comm field is parenthesized and may itself contain spaces or ')', so fields are
  // counted from the last ')' instead of splitting the whole line.
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/u);
  const starttime = fields[LINUX_PROC_STAT_STARTTIME_INDEX];
  if (starttime === undefined || !/^\d+$/u.test(starttime)) {
    return { unavailable: 'unparsable-proc-stat' };
  }
  return { token: `linux:${await readLinuxBootId()}:${starttime}` };
}

async function readLinuxBootId(): Promise<string> {
  try {
    const bootId = (await readFile(LINUX_BOOT_ID_PATH, 'utf8')).trim();
    return bootId.length > 0 ? bootId : 'unknown-boot';
  } catch {
    // Without a boot id the token still separates two processes inside one boot, which is
    // the case PID reuse actually happens in; a fixed marker keeps tokens comparable.
    return 'unknown-boot';
  }
}

async function readDarwinStartProbe(pid: number): Promise<ProcessStartProbe> {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
    timeout: PROBE_TIMEOUT_MS,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  const match = DARWIN_LSTART_PATTERN.exec(stdout.trim());
  if (!match) return { unavailable: 'unparsable-ps-lstart' };
  const month = MONTHS.indexOf(match[1] ?? '');
  if (month < 0) return { unavailable: 'unparsable-ps-lstart' };
  const startedAtMs = Date.UTC(
    Number(match[6]),
    month,
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  if (!Number.isSafeInteger(startedAtMs)) return { unavailable: 'unparsable-ps-lstart' };
  return { token: `darwin:${String(Math.floor(startedAtMs / 1_000))}` };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}
