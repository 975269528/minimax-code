import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../common/logger.js';
import { loadBetterSqlite3Module } from '../persistence/better-sqlite3-loader.js';
import type { DatabaseConstructor, DatabaseLike } from '../persistence/db.js';

export interface LegacyPinnedItemRef {
  type: 'agent' | 'session';
  id: string;
}

interface LegacyPreferenceRow {
  value?: string;
}

const PINNED_ITEMS_ORDER_PREFERENCE_KEY = 'pinned-items-order';

export async function readPreviewTrainPinnedItemsOrderPreference(
  dataDir: string,
): Promise<LegacyPinnedItemRef[]> {
  // The preview_train daemon's preferences table lives in dataDir/sqlite.db; the new runtime state database does not read it.
  const dbPath = path.join(dataDir, 'sqlite.db');
  // Legacy sqlite.db may no longer exist; treat this as no legacy data without affecting startup of the new pin service.
  if (!fs.existsSync(dbPath)) return [];

  let db: DatabaseLike | undefined;
  try {
    // Open the old database read-only to avoid accidentally modifying preview_train data during migration reads.
    const Database = loadBetterSqlite3Module<DatabaseConstructor>();
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // Some test profiles or earlier versions have no preferences table, meaning there is no legacy pin order to migrate.
    const hasPreferencesTable = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preferences'")
        .get() as { name?: string } | undefined
    )?.name;
    if (!hasPreferencesTable) return [];

    // The old KV stores the user's dragged mixed session/agent order, the authoritative source for this fix.
    const row = db
      .prepare('SELECT value FROM preferences WHERE key = ?')
      .get(PINNED_ITEMS_ORDER_PREFERENCE_KEY) as LegacyPreferenceRow | undefined;
    if (!row?.value) return [];

    const parsed = JSON.parse(row.value) as unknown;
    return readLegacyPinnedItems(parsed).flatMap((item) => {
      if (item.type !== 'agent' && item.type !== 'session') return [];
      const id = item.id?.trim();
      if (!id) return [];
      return [{ type: item.type, id }];
    });
  } catch (err) {
    // On database corruption or invalid JSON, fall back to no legacy preferences; legacy pinned columns can still fill gaps later.
    logger.warn({ err, dbPath }, 'Failed to read preview_train pinned-items-order preference');
    return [];
  } finally {
    db?.close();
  }
}

function readLegacyPinnedItems(value: unknown): Array<{ type: string; id: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type : undefined;
    const id =
      typeof record.id === 'string'
        ? record.id
        : typeof record.name === 'string'
          ? record.name
          : undefined;
    return type && id ? [{ type, id }] : [];
  });
}
