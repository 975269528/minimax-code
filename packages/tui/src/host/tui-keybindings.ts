import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { KeybindingsConfig, KeyId } from '../tui/engine/public.js';

const TUI_DIRECTORY = 'tui';
const TUI_KEYBINDINGS_FILE = 'keybindings.json';

export interface TuiKeybindingsReadResult {
  readonly path: string;
  readonly overrides: KeybindingsConfig;
  readonly error?: string;
}

/** Resolve the TUI-only keybindings file without touching Desktop config. */
export function getTuiKeybindingsPath(dataDir: string): string {
  return path.join(dataDir, TUI_DIRECTORY, TUI_KEYBINDINGS_FILE);
}

/**
 * Read the Pi-shaped flat keybinding map. Invalid files fail closed: callers
 * receive an empty override set and a diagnostic while the default bindings
 * remain available.
 */
export function readTuiKeybindingOverrides(dataDir: string): TuiKeybindingsReadResult {
  const filePath = getTuiKeybindingsPath(dataDir);
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('keybindings must be a JSON object');
    }
    const overrides: KeybindingsConfig = {};
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value === 'string') {
        overrides[id] = value as KeyId;
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        overrides[id] = value as KeyId[];
      } else if (value !== null) {
        throw new Error(`binding "${id}" must be a string or an array of strings`);
      }
    }
    return { path: filePath, overrides };
  } catch (error) {
    if (isMissingFile(error)) return { path: filePath, overrides: {} };
    return {
      path: filePath,
      overrides: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Write the complete user override map atomically under the TUI directory. */
export function writeTuiKeybindingOverrides(dataDir: string, overrides: KeybindingsConfig): string {
  const filePath = getTuiKeybindingsPath(dataDir);
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    directory,
    `.${TUI_KEYBINDINGS_FILE}.${process.pid}.${Date.now()}.tmp`,
  );
  const content = `${JSON.stringify(orderKeybindingOverrides(overrides), null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      // Best effort cleanup; a failed rename must not leave a stale temp file.
      unlinkSync(temporaryPath);
    } catch {
      // Ignore cleanup failures after reporting the original write failure.
    }
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
  return filePath;
}

function orderKeybindingOverrides(overrides: KeybindingsConfig): KeybindingsConfig {
  return Object.fromEntries(
    Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
