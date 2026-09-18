/**
 * Shared PID file format: parse and format runtime pid files.
 *
 * Two formats are supported:
 *   - Legacy: plain number string, e.g. "12345"
 *   - JSON:   {"pid":12345,"owner":"electron"|"cli"|"unknown","startedAt":1710000000000}
 *
 * All readers must handle both. Writers should use the new JSON format.
 *
 * @module
 */

/** Owner of the runtime process — determines who manages its lifecycle. */
export type PidOwner = 'electron' | 'cli' | 'unknown';

export interface PidInfo {
  pid: number;
  owner: PidOwner;
  startedAt?: number;
  mode?: string;
  startupToken?: string;
}

/**
 * Parse a runtime pid file content string into structured PidInfo.
 *
 * Handles both legacy (plain number) and new JSON formats.
 * Returns null if the content is unparseable.
 */
export function parsePidFile(raw: string): PidInfo | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try JSON format first (starts with '{')
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const pid = typeof obj.pid === 'number' ? obj.pid : parseInt(String(obj.pid), 10);
      if (isNaN(pid) || pid <= 0) return null;
      const owner = isValidOwner(obj.owner) ? obj.owner : 'unknown';
      const startedAt = parseStartedAt(obj.startedAt);
      return {
        pid,
        owner,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(typeof obj.mode === 'string' ? { mode: obj.mode } : {}),
        ...(typeof obj.startupToken === 'string' ? { startupToken: obj.startupToken } : {}),
      };
    } catch {
      return null;
    }
  }

  // Legacy format: plain number
  const pid = parseInt(trimmed, 10);
  if (isNaN(pid) || pid <= 0) return null;
  return { pid, owner: 'unknown' };
}

function isValidOwner(value: unknown): value is PidOwner {
  return value === 'electron' || value === 'cli' || value === 'unknown';
}

function parseStartedAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Format a PID info struct into the JSON file content.
 */
export function formatPidFile(pid: number, owner: PidOwner): string {
  const info: PidInfo = {
    pid,
    owner,
    startedAt: Date.now(),
  };
  return JSON.stringify(info);
}

/**
 * Determine the runtime owner based on runtime environment.
 *
 * - --owner electron indicates a supervisor manages runtime lifecycle.
 * - Otherwise the runtime was started by CLI / npm directly.
 */
export function detectPidOwner(): PidOwner {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value =
      arg === '--owner' ? args[i + 1] : arg?.startsWith('--owner=') ? arg.slice(8) : undefined;
    if (value === 'electron') return 'electron';
    if (value === 'service' || value === 'cli') return 'cli';
  }
  return 'cli';
}
