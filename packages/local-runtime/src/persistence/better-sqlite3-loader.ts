import { createRequire } from 'node:module';
import path from 'node:path';

export type BetterSqlite3Module<T> = T | { default?: T };

const require = createRequire(import.meta.url);

export function loadBetterSqlite3Module<T>(): T {
  const overridePath = getBetterSqlite3ModuleOverridePath(process.env.MAVIS_SQLITE3_MODULE_PATH);
  const mod = overridePath
    ? createRequire(path.join(overridePath, 'package.json'))('better-sqlite3')
    : require('better-sqlite3');
  return normalizeBetterSqlite3Module<T>(mod as BetterSqlite3Module<T>);
}

export function getBetterSqlite3ModuleOverridePath(value: string | undefined): string | undefined {
  const overridePath = value?.trim();
  if (!overridePath) return undefined;
  return isAsarUnpackedPath(overridePath) ? undefined : overridePath;
}

function normalizeBetterSqlite3Module<T>(mod: BetterSqlite3Module<T>): T {
  return (mod as { default?: T }).default ?? (mod as T);
}

function isAsarUnpackedPath(value: string): boolean {
  return path.normalize(value).split(path.sep).includes('app.asar.unpacked');
}
