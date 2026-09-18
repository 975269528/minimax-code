import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TuiMode } from '../tui/engine/public.js';

const TUI_SETTINGS_FILE = path.join('tui', 'tui-settings.json');
const LEGACY_TUI_SETTINGS_FILE = 'tui-settings.json';

interface TuiSettingsDocument {
  readonly tuiMode?: unknown;
}

export function readTuiModeSetting(dataDir: string): TuiMode {
  for (const file of [TUI_SETTINGS_FILE, LEGACY_TUI_SETTINGS_FILE]) {
    try {
      const content = readFileSync(path.join(dataDir, file), 'utf8').replace(/^\uFEFF/u, '');
      const document = JSON.parse(content) as TuiSettingsDocument;
      return document.tuiMode === 'fullscreen' ? 'fullscreen' : 'regular';
    } catch {
      // Try the legacy root location before falling back to the default mode.
    }
  }
  return 'regular';
}

export function writeTuiModeSetting(dataDir: string, mode: TuiMode): void {
  mkdirSync(path.dirname(path.join(dataDir, TUI_SETTINGS_FILE)), { recursive: true });
  writeFileSync(
    path.join(dataDir, TUI_SETTINGS_FILE),
    `${JSON.stringify({ tuiMode: mode }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
