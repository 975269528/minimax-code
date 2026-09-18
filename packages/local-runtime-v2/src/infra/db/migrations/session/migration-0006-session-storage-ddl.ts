export const SESSIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS local_runtime_sessions (
    session_id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    columnar_version INTEGER NOT NULL DEFAULT 0,
    agent_name TEXT,
    runtime TEXT,
    session_type TEXT,
    status TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible',
    session_kind TEXT NOT NULL DEFAULT 'unknown'
      CHECK (session_kind IN ('conversation', 'task', 'peek', 'channel', 'cron', 'unknown')),
    purpose TEXT,
    purpose_kind TEXT NOT NULL DEFAULT '',
    origin_cron_id TEXT,
    parent_session_id TEXT,
    workspace_dir TEXT,
    project_workspace_dir TEXT,
    is_default_workspace INTEGER NOT NULL DEFAULT 0
      CHECK (is_default_workspace IN (0, 1)),
    title TEXT,
    created_at_ms INTEGER,
    error_message TEXT,
    error_code INTEGER,
    extra_data_json TEXT NOT NULL DEFAULT '{}',
    project_id INTEGER
  );
`;

export const COMPATIBILITY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS local_runtime_session_schema_migrations (
    migration_key TEXT PRIMARY KEY,
    completed_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_session_fts_keys (
    fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS local_runtime_session_agent_state (
    session_id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL,
    turn_sequence INTEGER NOT NULL,
    runtime_seq INTEGER,
    event_id TEXT NOT NULL,
    terminal_outcome TEXT,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS local_runtime_projects (
    project_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_kind TEXT NOT NULL CHECK(project_kind IN ('default', 'workspace')),
    workspace_dir TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL DEFAULT 2147483647,
    recent_at_ms INTEGER,
    latest_activity_at_ms INTEGER NOT NULL DEFAULT 0,
    session_count INTEGER NOT NULL DEFAULT 0,
    extra_data_json TEXT NOT NULL DEFAULT '{}',
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    CHECK (
      (project_kind = 'default' AND workspace_dir IS NULL)
      OR (project_kind = 'workspace' AND workspace_dir IS NOT NULL AND trim(workspace_dir) <> '')
    )
  );
  CREATE TABLE IF NOT EXISTS local_runtime_project_migrations (
    migration_key TEXT PRIMARY KEY,
    completed_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_messages (
    session_id TEXT PRIMARY KEY,
    display_messages_json TEXT NOT NULL,
    pi_history_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_runtime_message_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    role TEXT,
    turn_id TEXT,
    source TEXT,
    source_context_json TEXT,
    created_at_ms INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_runtime_message_row_migrations (
    session_id TEXT PRIMARY KEY,
    display_rows_backfilled_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_session_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    msg_id TEXT NOT NULL,
    role TEXT,
    message_created_at_ms INTEGER NOT NULL,
    asset_index INTEGER NOT NULL,
    asset_key TEXT NOT NULL,
    source_tag TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT,
    asset_type TEXT,
    artifact_id TEXT,
    drive_node_id TEXT,
    data_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_runtime_session_asset_index_state (
    session_id TEXT PRIMARY KEY,
    index_version INTEGER NOT NULL,
    indexed_through_message_row_id INTEGER NOT NULL,
    indexed_at_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_json TEXT
  );

  CREATE TABLE IF NOT EXISTS local_runtime_queues (
    session_id TEXT PRIMARY KEY,
    items_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_runtime_queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    status TEXT,
    created_at_ms INTEGER NOT NULL,
    data_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_runtime_queue_row_migrations (
    session_id TEXT PRIMARY KEY,
    queue_rows_backfilled_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    framework_type TEXT NOT NULL,
    turn_id TEXT,
    model TEXT,
    ts INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL,
    raw TEXT
  );

  CREATE TABLE IF NOT EXISTS local_runtime_session_locks (
    session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    owner_kind TEXT NOT NULL,
    acquired_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_turn_ingress (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source TEXT NOT NULL,
    client_request_id TEXT,
    claim_id TEXT,
    claim_source TEXT,
    queue_item_ids_json TEXT,
    input_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'completed', 'failed', 'aborted')),
    accepted_at_ms INTEGER NOT NULL,
    accepted_sequence INTEGER,
    completed_at_ms INTEGER,
    queue_acknowledged_at_ms INTEGER,
    input_digest TEXT,
    input_metadata_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS local_runtime_turn_ingress_sequences (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS local_runtime_turn_ingress_client_requests (
    session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(session_id, client_request_id),
    FOREIGN KEY(turn_id) REFERENCES local_runtime_turn_ingress(turn_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS local_runtime_pi_history_file_migrations (
    session_id TEXT PRIMARY KEY,
    migrated_at_ms INTEGER NOT NULL,
    source TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    target_revision TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS local_runtime_legacy_migrations (
    legacy_session_id TEXT PRIMARY KEY,
    local_session_id TEXT NOT NULL,
    legacy_daemon_session_id TEXT,
    legacy_framework_session_id TEXT,
    source_runtime TEXT NOT NULL,
    status TEXT NOT NULL,
    migrated_at_ms INTEGER NOT NULL,
    source_updated_at_ms INTEGER,
    source_fingerprint TEXT,
    source_schema_fingerprint TEXT,
    source_checksum TEXT,
    display_checksum TEXT,
    pi_history_strategy TEXT,
    pi_history_converter_version INTEGER,
    source_manifest_json TEXT,
    source_message_count INTEGER,
    imported_message_count INTEGER,
    report_json TEXT,
    ledger_imported_at_ms INTEGER,
    projection_ready_at_ms INTEGER,
    display_ready_at_ms INTEGER,
    pi_history_ready_at_ms INTEGER,
    warnings_json TEXT,
    error_json TEXT
  );

`;

export const SESSION_FTS_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS local_runtime_sessions_fts USING fts5(
    session_id UNINDEXED,
    session_id_terms,
    agent_name_terms,
    title_terms,
    workspace_dir_terms,
    purpose_terms,
    status_terms,
    session_type_terms,
    tokenize = 'unicode61'
  );
`;

// prettier-ignore
export const SESSION_FTS_COLUMNS = ['session_id', 'session_id_terms', 'agent_name_terms', 'title_terms', 'workspace_dir_terms', 'purpose_terms', 'status_terms', 'session_type_terms'] as const;

export const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_updated_at
    ON local_runtime_sessions(updated_at_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_recency_v2
    ON local_runtime_sessions(updated_at_ms DESC, created_at_ms DESC, session_id ASC);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_agent_recency_v3
    ON local_runtime_sessions(agent_name, updated_at_ms DESC, created_at_ms DESC, session_id ASC)
    WHERE columnar_version = 3;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_agent_archive_recency_v3
    ON local_runtime_sessions(
      agent_name, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC
    ) WHERE columnar_version = 3;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_root_recency_v3
    ON local_runtime_sessions(agent_name, updated_at_ms DESC, created_at_ms DESC, session_id ASC)
    WHERE columnar_version = 3 AND parent_session_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_root_archive_recency_v3
    ON local_runtime_sessions(
      agent_name, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC
    ) WHERE columnar_version = 3 AND parent_session_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_parent_recency_v3
    ON local_runtime_sessions(
      parent_session_id, updated_at_ms DESC, created_at_ms DESC, session_id ASC
    ) WHERE columnar_version = 3;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_cron_origin_created_v3
    ON local_runtime_sessions(origin_cron_id, created_at_ms DESC, session_id ASC)
    WHERE columnar_version = 3 AND origin_cron_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_pi_stale_v3
    ON local_runtime_sessions(updated_at_ms ASC, session_id ASC)
    WHERE columnar_version = 3 AND runtime = 'pi-agent' AND status = 'started';
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_activity_v4
    ON local_runtime_sessions(project_id, updated_at_ms DESC)
    WHERE columnar_version = 3 AND archived = 0 AND visibility <> 'hidden'
      AND session_kind NOT IN ('peek', 'channel', 'cron');
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_root_recency_v4
    ON local_runtime_sessions(
      project_id, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC
    ) WHERE columnar_version = 3 AND parent_session_id IS NULL
      AND visibility <> 'hidden' AND session_kind NOT IN ('peek', 'channel', 'cron');
  CREATE INDEX IF NOT EXISTS idx_local_runtime_sessions_project_agent_root_recency_v4
    ON local_runtime_sessions(
      project_id, agent_name, archived, updated_at_ms DESC, created_at_ms DESC, session_id ASC
    ) WHERE columnar_version = 3 AND parent_session_id IS NULL
      AND visibility <> 'hidden' AND session_kind NOT IN ('peek', 'channel', 'cron');

  CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_session_fts_keys_session_id
    ON local_runtime_session_fts_keys(session_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_projects_one_default_v1
    ON local_runtime_projects(project_kind) WHERE project_kind = 'default';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_projects_workspace_v1
    ON local_runtime_projects(workspace_dir) WHERE project_kind = 'workspace';
  CREATE INDEX IF NOT EXISTS idx_local_runtime_projects_list_v1
    ON local_runtime_projects(
      hidden, pinned DESC, order_index ASC, latest_activity_at_ms DESC, project_id ASC
    );
  CREATE INDEX IF NOT EXISTS idx_local_runtime_projects_recent_v1
    ON local_runtime_projects(recent_at_ms DESC, project_id ASC)
    WHERE recent_at_ms IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_message_rows_session_message
    ON local_runtime_message_rows(session_id, msg_id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_message_rows_session_id
    ON local_runtime_message_rows(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_message_rows_session_role_id
    ON local_runtime_message_rows(session_id, role, id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_message_rows_turn_source
    ON local_runtime_message_rows(session_id, turn_id, role, id);

  CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_session_assets_session_message_key
    ON local_runtime_session_assets(session_id, msg_id, asset_key);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_session_assets_session_time
    ON local_runtime_session_assets(session_id, message_created_at_ms DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_session_assets_session_message
    ON local_runtime_session_assets(session_id, msg_id);

  CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_queue_items_session_item
    ON local_runtime_queue_items(session_id, item_id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_queue_items_session_id
    ON local_runtime_queue_items(session_id, id);

  CREATE INDEX IF NOT EXISTS idx_local_runtime_token_usage_session_ts
    ON local_runtime_token_usage(session_id, ts, id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_token_usage_agent_ts
    ON local_runtime_token_usage(agent_name, ts, id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_token_usage_ts
    ON local_runtime_token_usage(ts, id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_turn_ingress_claim_id
    ON local_runtime_turn_ingress(claim_id) WHERE claim_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_turn_ingress_client_request
    ON local_runtime_turn_ingress(session_id, client_request_id)
    WHERE client_request_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_turn_ingress_sequence
    ON local_runtime_turn_ingress(accepted_sequence)
    WHERE accepted_sequence IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_local_runtime_turn_ingress_session_accepted_sequence
    ON local_runtime_turn_ingress(session_id, accepted_sequence DESC)
    WHERE status = 'accepted';
  CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_turn_ingress_sequences_turn_id
    ON local_runtime_turn_ingress_sequences(turn_id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_turn_ingress_clients_turn
    ON local_runtime_turn_ingress_client_requests(turn_id, ordinal);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_local_runtime_legacy_migrations_local_session
    ON local_runtime_legacy_migrations(local_session_id);
  CREATE INDEX IF NOT EXISTS idx_local_runtime_legacy_migrations_framework_session
    ON local_runtime_legacy_migrations(legacy_framework_session_id);

`;

const PROJECT_AGGREGATE_ASSIGNMENTS = `latest_activity_at_ms = COALESCE((
      SELECT MAX(s.updated_at_ms)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind NOT IN ('peek', 'channel', 'cron')
    ), 0),
    session_count = (
      SELECT COUNT(*)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind NOT IN ('peek', 'channel', 'cron')
        AND s.parent_session_id IS NULL
    )`;

const INSERT_PROJECT_FOR_NEW_SESSION = `
  INSERT INTO local_runtime_projects(
    project_kind, workspace_dir, latest_activity_at_ms, created_at_ms, updated_at_ms
  )
  SELECT
    CASE WHEN NEW.is_default_workspace = 1 THEN 'default' ELSE 'workspace' END,
    CASE WHEN NEW.is_default_workspace = 1 THEN NULL ELSE NEW.project_workspace_dir END,
    CASE
      WHEN NEW.columnar_version = 3 AND NEW.archived = 0 AND NEW.visibility <> 'hidden'
        AND NEW.session_kind NOT IN ('peek', 'channel', 'cron')
      THEN NEW.updated_at_ms ELSE 0
    END,
    COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0),
    COALESCE(NEW.created_at_ms, NEW.updated_at_ms, 0)
  WHERE NEW.columnar_version = 3
    AND (
      NEW.is_default_workspace = 1
      OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '')
    )
  ON CONFLICT DO NOTHING;

  UPDATE local_runtime_sessions
  SET project_id = COALESCE((
    SELECT p.project_id
    FROM local_runtime_projects p
    WHERE NEW.columnar_version = 3
      AND (
        NEW.is_default_workspace = 1
        OR (NEW.project_workspace_dir IS NOT NULL AND trim(NEW.project_workspace_dir) <> '')
      )
      AND (
        (p.project_kind = 'default' AND NEW.is_default_workspace = 1)
        OR (
          p.project_kind = 'workspace' AND NOT (NEW.is_default_workspace = 1)
          AND p.workspace_dir = NEW.project_workspace_dir
        )
      )
  ), 0)
  WHERE session_id = NEW.session_id;
`;

export const PROJECT_TRIGGERS_SQL = `
  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_insert_v5
  AFTER INSERT ON local_runtime_sessions
  WHEN NEW.columnar_version = 3
  BEGIN
    ${INSERT_PROJECT_FOR_NEW_SESSION}
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id = (
      SELECT project_id FROM local_runtime_sessions WHERE session_id = NEW.session_id
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_assignment_v5
  AFTER UPDATE OF columnar_version, project_workspace_dir, is_default_workspace
  ON local_runtime_sessions
  WHEN NEW.columnar_version = 3
    AND (
      OLD.columnar_version IS NOT NEW.columnar_version
      OR OLD.project_workspace_dir IS NOT NEW.project_workspace_dir
      OR OLD.is_default_workspace IS NOT NEW.is_default_workspace
    )
  BEGIN
    ${INSERT_PROJECT_FOR_NEW_SESSION}
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id IN (
      COALESCE(OLD.project_id, 0),
      COALESCE((
        SELECT project_id FROM local_runtime_sessions WHERE session_id = NEW.session_id
      ), 0)
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_activity_v5
  AFTER UPDATE OF
    updated_at_ms, created_at_ms, archived, parent_session_id, session_type,
    visibility, session_kind
  ON local_runtime_sessions
  WHEN OLD.columnar_version IS NEW.columnar_version
    AND OLD.project_workspace_dir IS NEW.project_workspace_dir
    AND OLD.is_default_workspace IS NEW.is_default_workspace
  BEGIN
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id IN (COALESCE(OLD.project_id, 0), COALESCE(NEW.project_id, 0));
  END;

  CREATE TRIGGER IF NOT EXISTS trg_local_runtime_project_session_delete_v5
  AFTER DELETE ON local_runtime_sessions
  WHEN OLD.project_id > 0
  BEGIN
    UPDATE local_runtime_projects
    SET ${PROJECT_AGGREGATE_ASSIGNMENTS}
    WHERE project_id = OLD.project_id;
  END;
`;
