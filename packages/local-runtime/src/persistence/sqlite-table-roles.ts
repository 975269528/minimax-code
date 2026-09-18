export type LocalRuntimeSqliteTableRole =
  | 'schema_registry'
  | 'canonical_event_cursor'
  | 'active_projection'
  | 'compat_blob'
  | 'backfill_marker'
  | 'legacy_import_map'
  | 'runtime_coordination'
  | 'operational_state'
  | 'usage_accounting'
  | 'user_goal_state';

export interface LocalRuntimeSqliteTableRoleEntry {
  table: string;
  role: LocalRuntimeSqliteTableRole;
  alias: string;
  description: string;
}

export interface LocalRuntimeSqliteTableRoleGroup {
  role: LocalRuntimeSqliteTableRole;
  label: string;
  description: string;
  tables: string[];
}

export interface LocalRuntimeSqliteTableRoleLegend {
  schemaVersion: 1;
  physicalRenamePolicy: 'no_rename_existing_tables';
  note: string;
  groups: LocalRuntimeSqliteTableRoleGroup[];
  tables: LocalRuntimeSqliteTableRoleEntry[];
}

const GROUPS: LocalRuntimeSqliteTableRoleGroup[] = [
  {
    role: 'schema_registry',
    label: 'Schema registry',
    description: 'Tracks applied SQLite schema migrations only.',
    tables: ['local_runtime_schema_migrations'],
  },
  {
    role: 'canonical_event_cursor',
    label: 'Canonical event cursor',
    description:
      'Stores watermarks for append-only session ledger files under v2/sessions; it is not the event log body.',
    tables: ['local_runtime_ledger_watermarks'],
  },
  {
    role: 'active_projection',
    label: 'Active SQLite projection',
    description:
      'Current query/index projection used by session lists, visible history, Pi history, and queued messages.',
    tables: [
      'local_runtime_sessions',
      'local_runtime_agents',
      'local_runtime_message_rows',
      'local_runtime_pi_history_rows',
      'local_runtime_queue_items',
      'local_runtime_session_projection_watermarks',
    ],
  },
  {
    role: 'compat_blob',
    label: 'Compatibility blob',
    description: 'Older local-runtime blob storage kept only as a migration/backfill source.',
    tables: ['local_runtime_messages', 'local_runtime_queues'],
  },
  {
    role: 'backfill_marker',
    label: 'Backfill marker',
    description:
      'Per-session markers proving a compatibility blob was already converted into row storage.',
    tables: [
      'local_runtime_message_row_migrations',
      'local_runtime_pi_history_row_migrations',
      'local_runtime_queue_row_migrations',
    ],
  },
  {
    role: 'legacy_import_map',
    label: 'Legacy import map',
    description:
      'Legacy daemon/opencode mapping, status, source manifest, checksum, warning, and report data.',
    tables: [
      'local_runtime_legacy_migrations',
      'local_runtime_cron_legacy_imports',
      'local_runtime_cron_data_migrations',
    ],
  },
  {
    role: 'runtime_coordination',
    label: 'Runtime coordination',
    description: 'Short-lived coordination state for active local-runtime owners.',
    tables: ['local_runtime_session_locks'],
  },
  {
    role: 'usage_accounting',
    label: 'Usage accounting',
    description: 'Token usage and turn-level tool file-change accounting.',
    tables: [
      'local_runtime_token_usage',
      'local_runtime_turn_diffs',
      'local_runtime_turn_diff_journal',
      'local_runtime_turn_diff_rewind_operations',
      'local_runtime_turn_diff_retention_queue',
    ],
  },
  {
    role: 'operational_state',
    label: 'Operational state',
    description: 'Native runtime feature state unrelated to legacy migration naming.',
    tables: [
      'local_runtime_preferences',
      'local_runtime_communication_messages',
      'local_runtime_crons',
      'local_runtime_cron_session_history',
      'questionnaire_requests',
    ],
  },
  {
    role: 'user_goal_state',
    label: 'User goal state',
    description: 'Thread goal state, one active/paused/blocked/completed goal per session.',
    tables: ['local_runtime_thread_goals'],
  },
];

const TABLE_DESCRIPTIONS: Record<string, { alias: string; description: string }> = {
  local_runtime_schema_migrations: {
    alias: 'schema migration registry',
    description: 'Records applied local-runtime SQLite schema versions.',
  },
  local_runtime_sessions: {
    alias: 'session metadata projection',
    description: 'Stores LocalSessionRecord JSON for lists, lookup, and session tree projection.',
  },
  local_runtime_agents: {
    alias: 'agent metadata projection',
    description: 'Stores LocalAgentRecord JSON for local/manual/auto agent metadata.',
  },
  local_runtime_messages: {
    alias: 'legacy local-runtime message blob',
    description:
      'Older display/pi history blob row. Current reads backfill into row tables and then clear it.',
  },
  local_runtime_queues: {
    alias: 'legacy local-runtime queue blob',
    description:
      'Older queued-message blob row. Current reads backfill into local_runtime_queue_items.',
  },
  local_runtime_preferences: {
    alias: 'runtime preference key-value',
    description: 'Small runtime preference KV records stored as JSON values.',
  },
  local_runtime_message_rows: {
    alias: 'display history row projection',
    description: 'Current UI-visible message rows with stable order and session/msg_id uniqueness.',
  },
  local_runtime_message_row_migrations: {
    alias: 'display history backfill marker',
    description: 'Marks sessions whose old display message blob has been migrated to rows.',
  },
  local_runtime_pi_history_rows: {
    alias: 'Pi continuation history row projection',
    description:
      'Current model-continuity history rows, intentionally distinct from full UI history.',
  },
  local_runtime_pi_history_row_migrations: {
    alias: 'Pi history backfill marker',
    description: 'Marks sessions whose old Pi history blob has been migrated to rows.',
  },
  local_runtime_queue_items: {
    alias: 'queued message row state',
    description: 'Current queued user/channel turn items with per-session item ids.',
  },
  local_runtime_queue_row_migrations: {
    alias: 'queue backfill marker',
    description: 'Marks sessions whose old queue blob has been migrated to queue item rows.',
  },
  local_runtime_legacy_migrations: {
    alias: 'legacy daemon import map and report',
    description:
      'Maps legacy daemon/opencode sessions to local sessions and stores import status, counts, checksums, warnings, and reports.',
  },
  local_runtime_cron_legacy_imports: {
    alias: 'legacy .md cron import markers',
    description:
      'Records which (agent, cron) pairs from pre-SQLite on-disk .md cron files were imported, so the startup migration never re-imports or resurrects a deleted cron.',
  },
  local_runtime_cron_data_migrations: {
    alias: 'cron data migration markers',
    description:
      'Records one-shot cron data backfills such as purpose-tagged session history import into native cron history.',
  },
  local_runtime_session_locks: {
    alias: 'active session execution lock',
    description: 'Prevents multiple runtime owners from executing the same session simultaneously.',
  },
  local_runtime_ledger_watermarks: {
    alias: 'ledger append watermark',
    description:
      'Tracks the last ledger seq/event id for v2/sessions/YYYY/MM/DD/<session>/ledger.jsonl, with dev-draft v2/chats fallback.',
  },
  local_runtime_session_projection_watermarks: {
    alias: 'SQLite projection replay watermark',
    description: 'Tracks how far SQLite session/message projections have replayed the ledger.',
  },
  local_runtime_token_usage: {
    alias: 'token usage accounting',
    description: 'Stores per-turn token and cost usage for session/agent/global summaries.',
  },
  local_runtime_turn_diffs: {
    alias: 'turn file-change records',
    description: 'Stores finalized per-turn tool file changes, undo snapshots, and revert state.',
  },
  local_runtime_turn_diff_journal: {
    alias: 'turn file-change journal',
    description: 'Stores pending turns and per-tool before/after snapshots before finalization.',
  },
  local_runtime_turn_diff_rewind_operations: {
    alias: 'turn file-change rewind operation',
    description: 'Stores immutable batch Undo plans and terminal receipts for Session Rewind.',
  },
  local_runtime_turn_diff_retention_queue: {
    alias: 'turn file-change retention queue',
    description:
      'Indexes newly written terminal Turn Diff state for bounded time-ordered retention without scanning historical rows.',
  },
  local_runtime_communication_messages: {
    alias: 'session communication queue',
    description: 'Stores session-to-session communication records and dispatch status.',
  },
  local_runtime_crons: {
    alias: 'native cron config',
    description: 'Stores native cron task configuration by agent and cron name.',
  },
  local_runtime_cron_session_history: {
    alias: 'native cron session history',
    description: 'Stores sessions created by cron tasks.',
  },
  local_runtime_thread_goals: {
    alias: 'thread goal state',
    description: 'Stores codex-style thread goal objective and status by session.',
  },
  questionnaire_requests: {
    alias: 'questionnaire request lifecycle',
    description:
      'Stores V2 ask_user questionnaire requests, reply payloads, injection recovery stamps, and terminal status.',
  },
};

const ROLE_BY_TABLE = new Map<string, LocalRuntimeSqliteTableRole>(
  GROUPS.flatMap((group) => group.tables.map((table) => [table, group.role] as const)),
);

export function getLocalRuntimeSqliteTableRoleLegend(): LocalRuntimeSqliteTableRoleLegend {
  return {
    schemaVersion: 1,
    physicalRenamePolicy: 'no_rename_existing_tables',
    note: 'Physical SQLite table names are kept stable for compatibility; use role/alias fields in diagnostics and docs to distinguish current projections from compatibility blobs.',
    groups: GROUPS.map((group) => ({ ...group, tables: [...group.tables] })),
    tables: Object.entries(TABLE_DESCRIPTIONS).map(([table, info]) => ({
      table,
      role: ROLE_BY_TABLE.get(table) ?? 'operational_state',
      alias: info.alias,
      description: info.description,
    })),
  };
}
