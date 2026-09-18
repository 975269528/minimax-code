import fs from 'node:fs';
import path from 'node:path';

import { resolveAgentDbPath } from '../../agent/db.js';
import { loadBetterSqlite3Module } from '../better-sqlite3-loader.js';
import type { DatabaseConstructor, DatabaseLike } from '../db.js';
import { openLocalRuntimeDb } from '../db.js';
import {
  CANONICAL_AGENT_NAMES,
  type AgentNameConflictMigrationSkipCode,
  type AgentNameMapping,
} from './agent-name-conflict-migration-manifest.js';
import { tableColumns, tableExists } from './agent-name-conflict-migration-files.js';

const TARGET_AGENT_NAMES = CANONICAL_AGENT_NAMES;

export function inspectCanonicalAgentNameConflict(dataDir: string): {
  readonly hasConflict: boolean;
  readonly sourceRowCount: number;
  readonly conflictCount: number;
  readonly skipCode?: AgentNameConflictMigrationSkipCode;
} {
  const dbPath = resolveAgentDbPath(dataDir);
  if (!fs.existsSync(dbPath)) {
    return { hasConflict: false, sourceRowCount: 0, conflictCount: 0, skipCode: 'source_missing' };
  }
  const Database = loadBetterSqlite3Module<DatabaseConstructor>();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(db, 'agents')) {
      return { hasConflict: false, sourceRowCount: 0, conflictCount: 0, skipCode: 'table_missing' };
    }
    const hasCreationSource = tableColumns(db, 'agents').has('creation_source');
    const rows = db
      .prepare(
        hasCreationSource
          ? 'SELECT agent_name, creation_source FROM agents'
          : 'SELECT agent_name FROM agents',
      )
      .all() as Array<{ agent_name?: unknown; creation_source?: unknown }>;
    const conflictCount = rows.filter(
      (row) =>
        typeof row.agent_name === 'string' &&
        TARGET_AGENT_NAMES.includes(row.agent_name as (typeof TARGET_AGENT_NAMES)[number]) &&
        (!hasCreationSource || !isTrustedBuiltinCreationSource(row.creation_source)),
    ).length;
    return {
      hasConflict: conflictCount > 0,
      sourceRowCount: rows.length,
      conflictCount,
      ...(conflictCount === 0 ? { skipCode: 'no_conflict' as const } : {}),
    };
  } finally {
    db.close();
  }
}

export function collectMappings(db: DatabaseLike, dataDir: string): AgentNameMapping[] {
  const mappings: AgentNameMapping[] = [];
  const used = new Set<string>(
    (db.prepare('SELECT agent_name FROM agents').all() as Array<{ agent_name?: unknown }>)
      .map((row) => row.agent_name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const runtimeDb = openLocalRuntimeDb(dataDir);
  if (tableExists(runtimeDb, 'local_runtime_agents')) {
    for (const row of runtimeDb.prepare('SELECT name FROM local_runtime_agents').all() as Array<{
      name?: unknown;
    }>) {
      if (typeof row.name === 'string') used.add(row.name);
    }
  }
  const credentialsDir = path.join(dataDir, 'credentials');
  if (fs.existsSync(credentialsDir)) {
    for (const entry of fs.readdirSync(credentialsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) used.add(entry.name);
    }
  }
  for (const target of TARGET_AGENT_NAMES) {
    const row = db
      .prepare('SELECT creation_source FROM agents WHERE agent_name = ?')
      .get(target) as { creation_source?: unknown } | undefined;
    if (isTrustedBuiltinCreationSource(row?.creation_source) || !row) continue;
    let suffix = 1;
    let candidate = `custom-${target}`;
    while (
      used.has(candidate) ||
      fs.existsSync(path.join(dataDir, 'agents', candidate)) ||
      fs.existsSync(path.join(dataDir, 'credentials', candidate))
    ) {
      suffix += 1;
      candidate = `custom-${target}-${suffix}`;
    }
    used.add(candidate);
    mappings.push({ from: target, to: candidate, stage: 'prepared' });
  }
  return mappings;
}

function isTrustedBuiltinCreationSource(source: unknown): boolean {
  // Historical product-owned rows are promoted by builtin seeding.
  return source === 'builtin' || source === 'auto';
}
