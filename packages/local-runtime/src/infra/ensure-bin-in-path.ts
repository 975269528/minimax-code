/**
 * Inject `<dataDir>/bin` into `process.env.PATH` so that shell commands
 * spawned by the agent (via pi-mono's `getShellEnv()`) can find tools like
 * `mavis-trash`, `mavis`, and `minimax`.
 *
 * `getShellEnv()` (third_party/pi-mono) spreads `process.env` and prepends
 * `~/.pi/agent/bin`, but does NOT add the mavis data-dir bin. Rather than
 * patching third-party code, we inject the entry into `process.env` early
 * — once is enough for the lifetime of the Electron process.
 *
 * Idempotent: skips if the entry is already present.
 */
import { delimiter, join } from 'node:path';

export function ensureBinInProcessPath(dataDir: string): void {
  const binDir = join(dataDir, 'bin');
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = process.env[pathKey] ?? '';
  const entries = currentPath.split(delimiter).filter(Boolean);

  if (entries.includes(binDir)) return;

  // Prepend so mavis-trash takes priority over any stale copy elsewhere.
  process.env[pathKey] = [binDir, currentPath].filter(Boolean).join(delimiter);
}
