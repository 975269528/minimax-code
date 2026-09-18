import fs from 'node:fs';
import path from 'node:path';

import { loadBetterSqlite3Module } from '../better-sqlite3-loader.js';
import type { DatabaseConstructor, DatabaseLike } from '../db.js';
import { resolveV2DirectoryContract } from '../layout/v2-paths.js';
import {
  applyDirectoryAndPrimaryRename,
  ensureV2AgentNameConflictBackup,
  rewritePrimaryAgentDatabaseReferences,
} from './agent-name-conflict-migration-backup.js';
import {
  isRecord,
  parseJsonValueOrThrow,
  quoteIdentifier,
  rewriteKnownYamlFiles,
  rewritePlanFiles,
  rewriteStructuredValue,
  tableExists,
  writeJsonAtomic,
} from './agent-name-conflict-migration-files.js';
import type { AgentNameMapping } from './agent-name-conflict-migration-manifest.js';
import { rewriteRuntimeReferences } from './agent-name-conflict-migration-runtime.js';

const RECEIPT_FILE = 'builtin-agent-name-conflicts-v1.json';
const FROZEN_AGENT_DEFINITION_TABLES = [
  'local_runtime_session_agent_definitions',
  'local_runtime_task_session_bindings',
] as const;

type Receipt = {
  readonly schemaVersion: 1;
  readonly migrationId: string;
  readonly status: 'prepared' | 'in_progress' | 'completed' | 'failed';
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  readonly backupDir: string;
  readonly mappings: AgentNameMapping[];
};

/**
 * Target-side repair run after V2 imports legacy Agent rows and before Builtin
 * seeding. It owns the V2 connection, backup and durable receipt; callers
 * only provide safe Custom-directory discovery and canonical-file repair.
 */
export interface V2BuiltinAgentNameConflictMigrationInput {
  readonly dataDir: string;
  readonly builtinNames: readonly string[];
  readonly nowMs?: () => number;
  readonly listDirectCustomAgentNames: () => Promise<readonly string[]>;
  readonly rewriteMovedCanonicalAgent: (
    mapping: Readonly<Pick<AgentNameMapping, 'from' | 'to'>>,
  ) => Promise<void>;
}

/** Lock-held adapter input; the owning scope supplies the fixed dataDir. */
export type V2BuiltinAgentNameConflictRepairInput = Omit<
  V2BuiltinAgentNameConflictMigrationInput,
  'dataDir'
>;

export type V2BuiltinAgentNameConflictRepair = (
  input: V2BuiltinAgentNameConflictRepairInput,
) => Promise<void>;

/** Bind target repair to the caller's active dataDir migration lease. */
export function createV2BuiltinAgentNameConflictRepair(
  dataDir: string,
  requireActive: () => void,
): V2BuiltinAgentNameConflictRepair {
  return async (input) => {
    requireActive();
    await applyV2BuiltinAgentNameConflictMigration({ dataDir, ...input });
  };
}

export async function applyV2BuiltinAgentNameConflictMigration(
  input: V2BuiltinAgentNameConflictMigrationInput,
): Promise<void> {
  const database = openV2RuntimeDb(input.dataDir);
  try {
    await applyV2BuiltinAgentNameConflictMigrationOpenDatabase(input, database);
  } finally {
    database.close();
  }
}

async function applyV2BuiltinAgentNameConflictMigrationOpenDatabase(
  input: V2BuiltinAgentNameConflictMigrationInput,
  database: DatabaseLike,
): Promise<void> {
  const nowMs = input.nowMs ?? (() => Date.now());
  const layout = resolveV2DirectoryContract(input.dataDir);
  const receiptPath = path.join(layout.migrationManifests, RECEIPT_FILE);
  let receipt = readReceipt(receiptPath, input.dataDir);
  const collisions = await listBuiltinCustomCollisions(input, database);
  if (receipt?.status === 'completed') {
    if (collisions.length === 0) return;
    receipt = undefined;
  }
  if (!receipt) {
    if (collisions.length === 0) return;
    const startedAtMs = nowMs();
    const migrationId = `builtin-agent-name-conflicts-${startedAtMs}`;
    receipt = {
      schemaVersion: 1,
      migrationId,
      status: 'prepared',
      startedAtMs,
      updatedAtMs: startedAtMs,
      backupDir: path.join(layout.migrationBackups, migrationId),
      mappings: buildMappings(input.dataDir, database, collisions),
    };
    writeReceipt(receiptPath, receipt);
  }

  try {
    ensureV2AgentNameConflictBackup(input.dataDir, database, receipt.backupDir, receipt.mappings);
    receipt = updateReceipt(receipt, 'in_progress', nowMs());
    writeReceipt(receiptPath, receipt);
    for (const mapping of receipt.mappings) {
      applyDirectoryAndPrimaryRename(input.dataDir, database, mapping, nowMs);
      await input.rewriteMovedCanonicalAgent(mapping);
      receipt = updateReceipt(receipt, 'in_progress', nowMs());
      writeReceipt(receiptPath, receipt);
    }
    rewritePrimaryAgentDatabaseReferences(database, receipt.mappings);
    rewriteAffectedFrozenAgentDefinitions(database, receipt.mappings);
    rewriteRuntimeReferences(input.dataDir, database, receipt.mappings, nowMs);
    rewriteKnownYamlFiles(input.dataDir, receipt.mappings);
    rewritePlanFiles(input.dataDir, receipt.mappings);
    writeReceipt(receiptPath, updateReceipt(receipt, 'completed', nowMs()));
  } catch (error) {
    try {
      writeReceipt(receiptPath, updateReceipt(receipt, 'failed', nowMs()));
    } catch {
      // The prepared/in-progress receipt remains recoverable. Preserve the
      // original migration failure instead of replacing it with receipt I/O.
    }
    throw error;
  }
}

function openV2RuntimeDb(dataDir: string): DatabaseLike {
  const dbPath = resolveV2DirectoryContract(dataDir).runtimeStateDb;
  if (!fs.existsSync(dbPath)) throw new Error('v2_runtime_database_missing');
  const Database = loadBetterSqlite3Module<DatabaseConstructor>();
  const database = new Database(dbPath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function listBuiltinCustomCollisions(
  input: V2BuiltinAgentNameConflictMigrationInput,
  database: DatabaseLike,
): Promise<string[]> {
  if (input.builtinNames.length === 0) return [];
  const placeholders = input.builtinNames.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT agent_name FROM agents WHERE creation_source <> 'builtin' AND agent_name IN (${placeholders}) ORDER BY agent_name`,
    )
    .all(...input.builtinNames) as Array<{ agent_name?: unknown }>;
  const databaseNames = new Set(
    (database.prepare('SELECT agent_name FROM agents').all() as Array<{ agent_name?: unknown }>)
      .map((row) => row.agent_name)
      .filter((name): name is string => typeof name === 'string'),
  );
  const builtinNames = new Set(input.builtinNames);
  const fileOnlyNames = (await input.listDirectCustomAgentNames()).filter(
    (name) => builtinNames.has(name) && !databaseNames.has(name),
  );
  return [
    ...new Set(
      rows
        .map((row) => row.agent_name)
        .filter((name): name is string => typeof name === 'string')
        .concat(fileOnlyNames),
    ),
  ].sort();
}

function buildMappings(
  dataDir: string,
  database: DatabaseLike,
  names: readonly string[],
): AgentNameMapping[] {
  const occupied = new Set(
    (database.prepare('SELECT agent_name FROM agents').all() as Array<{ agent_name?: unknown }>)
      .map((row) => row.agent_name)
      .filter((name): name is string => typeof name === 'string'),
  );
  if (tableExists(database, 'local_runtime_agents')) {
    for (const row of database.prepare('SELECT name FROM local_runtime_agents').all() as Array<{
      name?: unknown;
    }>) {
      if (typeof row.name === 'string') occupied.add(row.name);
    }
  }
  return names.map((from) => {
    let suffix = 0;
    let to = `custom-${from}`;
    while (
      occupied.has(to) ||
      fs.existsSync(path.join(dataDir, 'agents', to)) ||
      fs.existsSync(path.join(dataDir, 'credentials', to))
    ) {
      suffix += 1;
      to = `custom-${from}-${suffix + 1}`;
    }
    occupied.add(to);
    return { from, to, stage: 'prepared' };
  });
}

function rewriteAffectedFrozenAgentDefinitions(
  database: DatabaseLike,
  mappings: readonly AgentNameMapping[],
): void {
  if (mappings.length === 0) return;
  for (const table of FROZEN_AGENT_DEFINITION_TABLES) {
    if (!tableExists(database, table)) continue;
    const rows = database
      .prepare(`SELECT session_id, definition_json FROM ${quoteIdentifier(table)}`)
      .all() as Array<{ session_id?: unknown; definition_json?: unknown }>;
    for (const row of rows) {
      if (typeof row.session_id !== 'string' || typeof row.definition_json !== 'string') {
        throw new Error(`invalid_frozen_agent_definition:${table}`);
      }
      const definition = parseJsonValueOrThrow(row.definition_json, `${table}.definition_json`);
      if (!isRecord(definition)) throw new Error(`invalid_frozen_agent_definition:${table}`);
      const rewritten = rewriteStructuredValue(definition, [...mappings], false);
      if (!rewritten.changed) continue;
      database
        .prepare(`UPDATE ${quoteIdentifier(table)} SET definition_json = ? WHERE session_id = ?`)
        .run(JSON.stringify(rewritten.value), row.session_id);
    }
  }
}

function updateReceipt(receipt: Receipt, status: Receipt['status'], updatedAtMs: number): Receipt {
  return { ...receipt, status, updatedAtMs };
}

function readReceipt(filePath: string, dataDir: string): Receipt | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    throw new Error('invalid_builtin_agent_name_conflict_receipt');
  }
  if (!isRecord(value) || !isReceiptEnvelope(value)) {
    throw new Error('invalid_builtin_agent_name_conflict_receipt');
  }
  if (value.migrationId !== `builtin-agent-name-conflicts-${value.startedAtMs}`) {
    throw new Error('invalid_builtin_agent_name_conflict_receipt');
  }
  const mappings = validateMappings(value.mappings);
  if (value.status === 'completed' && mappings.some((mapping) => mapping.stage !== 'renamed')) {
    throw new Error('invalid_builtin_agent_name_conflict_receipt');
  }
  return {
    schemaVersion: 1,
    migrationId: value.migrationId,
    status: value.status,
    startedAtMs: value.startedAtMs,
    updatedAtMs: value.updatedAtMs,
    // The persisted path is diagnostic metadata only. Recover it from the
    // fixed data root and migration id on every retry.
    backupDir: path.join(resolveV2DirectoryContract(dataDir).migrationBackups, value.migrationId),
    mappings,
  };
}

function isReceiptEnvelope(value: Record<string, unknown>): value is {
  schemaVersion: 1;
  migrationId: string;
  status: Receipt['status'];
  startedAtMs: number;
  updatedAtMs: number;
  mappings: unknown[];
} {
  return (
    value.schemaVersion === 1 &&
    typeof value.migrationId === 'string' &&
    isReceiptStatus(value.status) &&
    isSafeTimestamp(value.startedAtMs) &&
    isSafeTimestamp(value.updatedAtMs) &&
    value.updatedAtMs >= value.startedAtMs &&
    Array.isArray(value.mappings)
  );
}

function isReceiptStatus(value: unknown): value is Receipt['status'] {
  return (
    value === 'prepared' || value === 'in_progress' || value === 'completed' || value === 'failed'
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validateMappings(mappings: readonly unknown[]): AgentNameMapping[] {
  if (mappings.length === 0) throw new Error('invalid_builtin_agent_name_conflict_receipt');
  const seenFrom = new Set<string>();
  const seenTo = new Set<string>();
  const validated: AgentNameMapping[] = [];
  for (const mapping of mappings) {
    if (!isRecord(mapping) || !isValidMapping(mapping, seenFrom, seenTo)) {
      throw new Error('invalid_builtin_agent_name_conflict_receipt');
    }
    seenFrom.add(mapping.from);
    seenTo.add(mapping.to);
    validated.push({ from: mapping.from, to: mapping.to, stage: mapping.stage });
  }
  return validated;
}

function isValidMapping(
  value: Record<string, unknown>,
  seenFrom: ReadonlySet<string>,
  seenTo: ReadonlySet<string>,
): value is { from: string; to: string; stage: 'prepared' | 'renamed' } {
  if (
    typeof value.from !== 'string' ||
    typeof value.to !== 'string' ||
    (value.stage !== 'prepared' && value.stage !== 'renamed') ||
    !isSafeMappingName(value.from) ||
    !isSafeMappingName(value.to) ||
    seenFrom.has(value.from) ||
    seenTo.has(value.to)
  ) {
    return false;
  }
  return new RegExp(`^custom-${escapeRegExp(value.from)}(?:-(?:[2-9]|[1-9][0-9]+))?$`, 'u').test(
    value.to,
  );
}

function isSafeMappingName(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('..');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function writeReceipt(filePath: string, receipt: Receipt): void {
  writeJsonAtomic(filePath, receipt);
}
