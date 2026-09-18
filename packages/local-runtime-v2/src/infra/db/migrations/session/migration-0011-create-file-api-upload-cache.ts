import type { MigrationEntry } from '../../migrate.js';

/** Frozen v2 Session-scoped File API upload cache schema. */
export const migration: MigrationEntry = {
  version: 11,
  name: 'create_file_api_upload_cache',
  up: `
    CREATE TABLE local_runtime_file_api_uploads (
      session_id TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      endpoint_hash TEXT NOT NULL,
      caller_identity_hash TEXT NOT NULL,
      ttl_sec REAL NOT NULL,
      file_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, cache_key),
      CONSTRAINT local_runtime_file_api_uploads_ttl_check CHECK (ttl_sec >= 0),
      CONSTRAINT local_runtime_file_api_uploads_file_id_check CHECK (length(file_id) > 0),
      FOREIGN KEY (session_id) REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_local_runtime_file_api_uploads_session_expiry
      ON local_runtime_file_api_uploads(session_id, expires_at_ms);
  `,
};
