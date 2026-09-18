import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { resolveAgentDbPath } from '../../agent/db.js';
import { loadBetterSqlite3Module } from '../better-sqlite3-loader.js';
import type { DatabaseLike } from '../db.js';
import { openLocalRuntimeDb } from '../db.js';
import type { AgentNameMapping } from './agent-name-conflict-migration-manifest.js';
import {
  isRecord,
  listTables,
  mapAgentName,
  parseJsonValueOrThrow,
  quoteIdentifier,
  readAffectedPlanFiles,
  tableColumns,
  tableExists,
} from './agent-name-conflict-migration-files.js';
import { discoverAffectedLedgerSessions } from './agent-name-conflict-migration-runtime.js';
import { resolveV2DirectoryContract } from '../layout/v2-paths.js';
import { resolveV2SessionArtifactPathsSync } from '../layout/v2-session-artifacts.js';

const ROOT_AGENT_DEFINITION_FILE = 'agent.md';
const UNREADABLE_ROOT_AGENT_DEFINITION_MARKER_FILE = `${ROOT_AGENT_DEFINITION_FILE}.unreadable.json`;
const UNREADABLE_ROOT_AGENT_DEFINITION_MARKER = JSON.stringify(
  {
    schemaVersion: 1,
    source: ROOT_AGENT_DEFINITION_FILE,
    status: 'unreadable',
    reason: 'access_denied',
    recovery: 'The original file remains in the renamed agent directory.',
  },
  null,
  2,
).concat('\n');

type RootAgentDefinitionBackup =
  | { readonly status: 'copied'; readonly recursive: boolean }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' };

export function ensureBackup(
  dataDir: string,
  agentDb: DatabaseLike,
  backupDir: string,
  mappings: AgentNameMapping[],
): void {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  backupSqlite(agentDb, path.join(backupDir, path.basename(resolveAgentDbPath(dataDir))));
  const runtimeDbPath = resolveV2DirectoryContract(dataDir).runtimeStateDb;
  if (fs.existsSync(runtimeDbPath)) {
    const Database =
      loadBetterSqlite3Module<
        new (filename: string, options?: Record<string, unknown>) => DatabaseLike
      >();
    const source = new Database(runtimeDbPath, { readonly: true, fileMustExist: true });
    try {
      backupSqlite(source, path.join(backupDir, path.basename(runtimeDbPath)));
    } finally {
      source.close();
    }
  }
  ensureBackupArtifacts(dataDir, backupDir, mappings);
}

/**
 * V2 owns the runtime-state database, so its startup collision repair backs
 * up that already-open connection once before changing any names or files.
 */
export function ensureV2AgentNameConflictBackup(
  dataDir: string,
  runtimeDb: DatabaseLike,
  backupDir: string,
  mappings: AgentNameMapping[],
): void {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const runtimeDbPath = resolveV2DirectoryContract(dataDir).runtimeStateDb;
  backupSqlite(runtimeDb, path.join(backupDir, path.basename(runtimeDbPath)));
  ensureBackupArtifacts(dataDir, backupDir, mappings, runtimeDb);
}

function ensureBackupArtifacts(
  dataDir: string,
  backupDir: string,
  mappings: AgentNameMapping[],
  runtimeDb?: DatabaseLike,
): void {
  const files = [
    'channel-bindings.yaml',
    'feishu-channel.yaml',
    'telegram-channel.yaml',
    'wechat-channel.yaml',
    'channel-routes.yaml',
    'channel-owner.yaml',
    'access-control.yaml',
  ];
  const fileBackupDir = path.join(backupDir, 'files');
  for (const file of files) {
    const source = path.join(dataDir, file);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(fileBackupDir, { recursive: true, mode: 0o700 });
    const target = path.join(fileBackupDir, file);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
  }
  const agentBackupDir = path.join(backupDir, 'agents');
  for (const mapping of mappings) {
    const source = path.join(dataDir, 'agents', mapping.from);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(agentBackupDir, { recursive: true, mode: 0o700 });
    const target = path.join(agentBackupDir, mapping.from);
    backupMappedAgentDirectory(source, target);
  }
  const credentialsBackupDir = path.join(backupDir, 'credentials');
  for (const mapping of mappings) {
    const source = path.join(dataDir, 'credentials', mapping.from);
    if (!fs.existsSync(source)) continue;
    const target = path.join(credentialsBackupDir, mapping.from);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(source, target, { recursive: true });
  }
  const planBackupDir = path.join(backupDir, 'plans');
  for (const plan of readAffectedPlanFiles(dataDir, mappings)) {
    const target = path.join(planBackupDir, plan.planId, 'plan.json');
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(plan.filePath, target);
  }
  const resolvedRuntimeDb = runtimeDb ?? openLocalRuntimeDb(dataDir);
  const sessionBackupDir = path.join(backupDir, 'sessions');
  for (const row of resolvedRuntimeDb
    .prepare('SELECT session_id, record_json FROM local_runtime_sessions')
    .all() as Array<{ session_id?: unknown; record_json?: unknown }>) {
    if (typeof row.session_id !== 'string' || typeof row.record_json !== 'string') continue;
    let record: unknown;
    try {
      record = JSON.parse(row.record_json);
    } catch {
      throw new Error(`invalid_json:local_runtime_sessions.record_json`);
    }
    if (!isRecord(record) || !mappings.some((mapping) => record.agentName === mapping.from))
      continue;
    const sessionPaths = resolveV2SessionArtifactPathsSync(dataDir, row.session_id);
    const target = path.join(sessionBackupDir, row.session_id);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const file of [sessionPaths.ledger, sessionPaths.snapshot]) {
      const targetFile = path.join(target, path.basename(file));
      if (fs.existsSync(file) && !fs.existsSync(targetFile)) fs.copyFileSync(file, targetFile);
    }
  }
  for (const session of discoverAffectedLedgerSessions(dataDir, mappings)) {
    const target = path.join(sessionBackupDir, session.sessionId);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const file of [session.paths.ledger, session.paths.snapshot]) {
      const targetFile = path.join(target, path.basename(file));
      if (fs.existsSync(file) && !fs.existsSync(targetFile)) fs.copyFileSync(file, targetFile);
    }
  }
  const trackingDir = path.join(dataDir, 'memory', 'tracking');
  if (fs.existsSync(trackingDir)) {
    const target = path.join(backupDir, 'memory', 'tracking');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(trackingDir)) {
      const targetFile = path.join(target, file);
      if (file.endsWith('.json') && !fs.existsSync(targetFile))
        fs.copyFileSync(path.join(trackingDir, file), targetFile);
    }
  }
}

/**
 * A root `agent.md` with denied read access is a per-Agent configuration
 * failure: preserve it by rename, leave a recovery marker in the backup, and
 * allow startup to report the bounded configuration diagnostic later. Every
 * other source or destination failure remains a migration failure.
 */
function backupMappedAgentDirectory(source: string, target: string): void {
  // Backups are immutable once published. Their existence means a previous
  // invocation completed the entire Agent directory backup.
  if (fs.existsSync(target)) return;

  const sourceAgentDefinition = path.resolve(source, ROOT_AGENT_DEFINITION_FILE);
  const staging = `${target}.agent-name-conflict-staging`;

  // Publish only a complete directory. Failed copies remain in staging, so a
  // retry cannot mistake a partial directory for a complete backup.
  fs.rmSync(staging, { recursive: true, force: true });
  const definition = inspectRootAgentDefinitionForBackup(sourceAgentDefinition);

  fs.cpSync(source, staging, {
    recursive: true,
    filter: (entry) => path.resolve(entry) !== sourceAgentDefinition,
  });
  if (definition.status === 'copied') {
    fs.cpSync(sourceAgentDefinition, path.join(staging, ROOT_AGENT_DEFINITION_FILE), {
      recursive: definition.recursive,
    });
  }
  if (definition.status === 'unreadable') {
    fs.writeFileSync(
      path.join(staging, UNREADABLE_ROOT_AGENT_DEFINITION_MARKER_FILE),
      UNREADABLE_ROOT_AGENT_DEFINITION_MARKER,
      {
        mode: 0o600,
      },
    );
  }
  fs.renameSync(staging, target);
}

function inspectRootAgentDefinitionForBackup(source: string): RootAgentDefinitionBackup {
  let metadata: ReturnType<typeof fs.lstatSync>;
  try {
    metadata = fs.lstatSync(source);
  } catch (error) {
    const knownFailure = rootAgentDefinitionAccessFailure(error);
    if (knownFailure) return knownFailure;
    throw error;
  }
  // `lstatSync` deliberately distinguishes a direct directory from a symlink
  // to one. Only a real directory needs recursive copying; links and special
  // files retain the ordinary `cpSync` behavior used by the original backup.
  if (!metadata.isFile()) return { status: 'copied', recursive: metadata.isDirectory() };

  let descriptor: number;
  try {
    descriptor = fs.openSync(source, 'r');
  } catch (error) {
    const knownFailure = rootAgentDefinitionAccessFailure(error);
    if (knownFailure) return knownFailure;
    throw error;
  }
  fs.closeSync(descriptor);
  return { status: 'copied', recursive: false };
}

function rootAgentDefinitionAccessFailure(
  error: unknown,
): Extract<RootAgentDefinitionBackup, { readonly status: 'missing' | 'unreadable' }> | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return { status: 'unreadable' };
  if (code === 'ENOENT') return { status: 'missing' };
  return undefined;
}

function backupSqlite(db: DatabaseLike, target: string): void {
  if (fs.existsSync(target)) return;
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function applyDirectoryAndPrimaryRename(
  dataDir: string,
  db: DatabaseLike,
  mapping: AgentNameMapping,
  nowMs: () => number,
): void {
  const agentsDir = path.join(dataDir, 'agents');
  const sourceDir = path.join(agentsDir, mapping.from);
  const targetDir = path.join(agentsDir, mapping.to);
  const stagingDir = path.join(agentsDir, `.agent-name-conflict-${mapping.from}.tmp`);
  const credentialsDir = path.join(dataDir, 'credentials');
  const sourceCredentialsDir = path.join(credentialsDir, mapping.from);
  const targetCredentialsDir = path.join(credentialsDir, mapping.to);
  const stagingCredentialsDir = path.join(
    credentialsDir,
    `.agent-name-conflict-${mapping.from}.tmp`,
  );
  const sourceRow = db
    .prepare('SELECT creation_source FROM agents WHERE agent_name = ?')
    .get(mapping.from) as { creation_source?: unknown } | undefined;
  const targetRow = db
    .prepare('SELECT creation_source FROM agents WHERE agent_name = ?')
    .get(mapping.to) as { creation_source?: unknown } | undefined;

  if (sourceRow && targetRow) {
    throw new Error(`rename_target_already_exists:${mapping.from}:${mapping.to}`);
  }
  if ((fs.existsSync(sourceDir) || fs.existsSync(stagingDir)) && fs.existsSync(targetDir)) {
    throw new Error(`rename_directory_target_already_exists:${mapping.from}:${mapping.to}`);
  }
  if (
    (fs.existsSync(sourceCredentialsDir) || fs.existsSync(stagingCredentialsDir)) &&
    fs.existsSync(targetCredentialsDir)
  ) {
    throw new Error(`rename_credentials_target_already_exists:${mapping.from}:${mapping.to}`);
  }
  if (fs.existsSync(sourceDir) && !fs.existsSync(stagingDir)) fs.renameSync(sourceDir, stagingDir);
  if (fs.existsSync(sourceCredentialsDir) && !fs.existsSync(stagingCredentialsDir)) {
    fs.renameSync(sourceCredentialsDir, stagingCredentialsDir);
  }
  if (sourceRow) {
    db.prepare('UPDATE agents SET agent_name = ?, updated_at = ? WHERE agent_name = ?').run(
      mapping.to,
      nowMs(),
      mapping.from,
    );
  }
  if (fs.existsSync(stagingDir) && !fs.existsSync(targetDir)) fs.renameSync(stagingDir, targetDir);
  if (fs.existsSync(stagingCredentialsDir) && !fs.existsSync(targetCredentialsDir)) {
    fs.renameSync(stagingCredentialsDir, targetCredentialsDir);
  }
  if (sourceRow && !db.prepare('SELECT 1 FROM agents WHERE agent_name = ?').get(mapping.to)) {
    throw new Error(`rename_primary_row_missing:${mapping.from}:${mapping.to}`);
  }
  mapping.stage = 'renamed';
  // The caller persists the manifest at the next phase boundary. Directory
  // staging and the fixed mapping make a retry deterministic even if the
  // process exits before that write.
}

export function rewritePrimaryAgentDatabaseReferences(
  db: DatabaseLike,
  mappings: AgentNameMapping[],
): number {
  let updated = 0;
  for (const table of listTables(db)) {
    // `agents.agent_name` is handled by applyDirectoryAndPrimaryRename. Every
    // other legacy table that carries the same foreign key must move in the
    // same SQLite transaction so a key collision rolls back the whole DB.
    if (table === 'agents') continue;
    if (!tableColumns(db, table).has('agent_name')) continue;
    for (const mapping of mappings) {
      const result = db
        .prepare(`UPDATE ${quoteIdentifier(table)} SET agent_name = ? WHERE agent_name = ?`)
        .run(mapping.to, mapping.from) as { changes?: number };
      updated += result.changes ?? 0;
    }
  }
  updated += rewritePrimaryPinnedItemsPreference(db, mappings);
  return updated;
}

function rewritePrimaryPinnedItemsPreference(
  db: DatabaseLike,
  mappings: AgentNameMapping[],
): number {
  if (!tableExists(db, 'preferences')) return 0;
  const columns = tableColumns(db, 'preferences');
  if (!columns.has('key') || !columns.has('value')) return 0;
  const row = db
    .prepare('SELECT rowid, value FROM preferences WHERE key = ?')
    .get('pinned-items-order') as { rowid?: unknown; value?: unknown } | undefined;
  if (typeof row?.rowid !== 'number' || typeof row.value !== 'string') return 0;
  const parsed = parseJsonValueOrThrow(row.value, 'preferences.pinned-items-order');
  if (!Array.isArray(parsed)) return 0;
  let changed = false;
  let count = 0;
  const next = parsed.map((item) => {
    if (!isRecord(item) || item.type !== 'agent' || typeof item.id !== 'string') return item;
    const mapped = mapAgentName(item.id, mappings);
    if (mapped === item.id) return item;
    changed = true;
    count += 1;
    return { ...item, id: mapped };
  });
  if (!changed) return 0;
  db.prepare('UPDATE preferences SET value = ? WHERE rowid = ?').run(
    JSON.stringify(next),
    row.rowid,
  );
  return count;
}
