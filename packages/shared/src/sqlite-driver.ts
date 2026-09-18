import path from 'node:path';
import { createRequire } from 'node:module';

// Extracted from @types/better-sqlite3 to avoid a build-time dependency here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BetterSqlite3Module = new (filename?: string | Buffer, options?: any) => any;

const require = createRequire(import.meta.url);

function normalizeBetterSqlite3Module(
  mod: BetterSqlite3Module | { default?: BetterSqlite3Module },
): BetterSqlite3Module {
  return (mod as { default?: BetterSqlite3Module }).default ?? (mod as BetterSqlite3Module);
}

export function loadBetterSqlite3(): BetterSqlite3Module {
  const overridePath = process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
  if (overridePath) {
    const overrideRequire = createRequire(path.join(overridePath, 'package.json'));
    return normalizeBetterSqlite3Module(overrideRequire('better-sqlite3'));
  }
  return normalizeBetterSqlite3Module(require('better-sqlite3'));
}
