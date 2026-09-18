import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';
import { publishedAgentLegacyHistoryNoticeRepairMigration } from '../agent/migration-0032-repair-legacy-history-notice-version-collision.js';
import { migration as canvasRepairMigration } from '../canvas/migration-0031-repair-canvas-version-collision.js';
import { publishedCronExecutionFieldsMigration } from '../runtime/migration-0026-add-cron-execution-fields.js';
import { publishedCronSessionTargetModeMigration } from '../cron/migration-0027-add-cron-session-target-mode.js';
import { migration as liveBoardRepairMigration } from '../miniapp/migration-0030-repair-liveboard-state-version-collision.js';
import { migration as sessionResourcesMigration } from './migration-0025-create-session-resources.js';
import { migration as sourceToolCallIndexMigration } from './migration-0026-relax-source-tool-call-index.js';
import { migration as taskBindingsRepairMigration } from './migration-0027-repair-task-session-bindings-version-collision.js';
import { migration as historyLocationRepairMigration } from './migration-0028-repair-session-history-relative-dir-version-collision.js';
import { migration as queuePausesRepairMigration } from './migration-0029-repair-queue-pauses-version-collision.js';
import { migration as queryCollapseMigration } from './migration-0016-create-query-collapse-view-states.js';
import { migration as continuationDurationRepairMigration } from './migration-0032-repair-query-continuation-duration.js';
import { migration as sharedProjectSchemaCompatibilityMigration } from './migration-0034-restore-shared-project-schema-compatibility.js';
import { publishedSessionAgentDefinitionsMigration } from './migration-0025-create-session-agent-definitions.js';

const CANVAS_TABLES = [
  'local_runtime_canvas_documents',
  'local_runtime_canvas_operations',
  'local_runtime_canvas_asset_references',
] as const;

/**
 * PreviewTrain and the published Agents train assigned different durable
 * meanings to versions 25–32. Keep their markers untouched and repair only
 * contracts whose physical objects are absent before recording version 35.
 */
export const migration: MigrationEntry = {
  version: 35,
  name: 'converge_published_schema_version_collisions',
  up: convergePublishedSchemaCollisions,
};

function convergePublishedSchemaCollisions(database: MigrationDatabase): void {
  ensurePreviewSessionContracts(database);
  ensurePublishedAgentContracts(database);
  runMigration(database, continuationDurationRepairMigration);
  runMigration(database, sharedProjectSchemaCompatibilityMigration);
}

function ensurePreviewSessionContracts(database: MigrationDatabase): void {
  if (!tableExists(database, 'local_runtime_query_view_states')) {
    runMigration(database, queryCollapseMigration);
  }
  if (!tableExists(database, 'local_runtime_task_session_bindings')) {
    runMigration(database, taskBindingsRepairMigration);
  }
  if (!tableExists(database, 'local_runtime_queue_pauses')) {
    runMigration(database, queuePausesRepairMigration);
  }
  if (!tableHasColumn(database, 'local_runtime_sessions', 'history_relative_dir')) {
    runMigration(database, historyLocationRepairMigration);
  }
  if (!tableExists(database, 'local_runtime_liveboard_state')) {
    runMigration(database, liveBoardRepairMigration);
  }
  if (!canvasContractExists(database)) runMigration(database, canvasRepairMigration);
  if (sourceResourceTablesMissing(database)) runMigration(database, sessionResourcesMigration);
  if (sourceToolCallIndexNeedsRepair(database))
    runMigration(database, sourceToolCallIndexMigration);
}

function ensurePublishedAgentContracts(database: MigrationDatabase): void {
  if (!tableExists(database, 'local_runtime_session_agent_definitions')) {
    runMigration(database, publishedSessionAgentDefinitionsMigration);
  }
  if (cronExecutionFieldsMissing(database)) {
    runMigration(database, publishedCronExecutionFieldsMigration);
  }
  if (!tableHasColumn(database, 'local_runtime_v2_cron_definitions', 'session_target_mode')) {
    runMigration(database, publishedCronSessionTargetModeMigration);
  }
  if (!tableHasColumn(database, 'agents', 'legacy_history_session_id')) {
    runMigration(database, publishedAgentLegacyHistoryNoticeRepairMigration);
  }
}

function sourceResourceTablesMissing(database: MigrationDatabase): boolean {
  return (
    !tableExists(database, 'session_resources') || !tableExists(database, 'session_turn_resources')
  );
}

function canvasContractExists(database: MigrationDatabase): boolean {
  return (
    CANVAS_TABLES.every((tableName) => tableExists(database, tableName)) &&
    indexExists(database, 'idx_canvas_asset_references_asset')
  );
}

function sourceToolCallIndexNeedsRepair(database: MigrationDatabase): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .all('idx_session_turn_resources_tool_call')[0];
  if (!row || typeof row !== 'object' || !('sql' in row) || typeof row.sql !== 'string') {
    return true;
  }
  return (
    row.sql.replace(/\s+/gu, ' ').trim().toLowerCase() !==
    'create index idx_session_turn_resources_tool_call on session_turn_resources(session_id, msg_id, tool_call_id)'
  );
}

function cronExecutionFieldsMissing(database: MigrationDatabase): boolean {
  return (
    !tableHasColumn(database, 'local_runtime_v2_cron_definitions', 'project') ||
    !tableHasColumn(database, 'local_runtime_v2_cron_definitions', 'model') ||
    !tableHasColumn(database, 'local_runtime_v2_cron_runs', 'manual_request_id')
  );
}

function tableExists(database: MigrationDatabase, tableName: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").all(tableName)
      .length > 0
  );
}

function indexExists(database: MigrationDatabase, indexName: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").all(indexName)
      .length > 0
  );
}

function tableHasColumn(
  database: MigrationDatabase,
  tableName: string,
  columnName: string,
): boolean {
  return (
    database
      .prepare(`SELECT name FROM pragma_table_info('${tableName}') WHERE name = ?`)
      .all(columnName).length > 0
  );
}

function runMigration(database: MigrationDatabase, entry: MigrationEntry): void {
  if (typeof entry.up === 'string') database.exec(entry.up);
  else entry.up(database);
}
