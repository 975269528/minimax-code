import type { MigrationEntry } from '../../migrate.js';

/**
 * Adopts the existing Plugin state tables into the runtime-v2 migration catalog.
 * Earlier builds created these tables from the service repository. The idempotent
 * DDL preserves their data before removing the obsolete service-owned marker.
 */
export const migration: MigrationEntry = {
  version: 5,
  name: 'adopt_plugin_state',
  up: `
    CREATE TABLE IF NOT EXISTS local_runtime_plugin_official_state (
      principal_id TEXT NOT NULL,
      deployment TEXT NOT NULL,
      state_json TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (principal_id, deployment)
    );
    CREATE TABLE IF NOT EXISTS local_runtime_plugin_local_disabled (
      canonical_root TEXT PRIMARY KEY,
      updated_at_ms INTEGER NOT NULL
    );
    DROP TABLE IF EXISTS local_runtime_plugin_schema_migrations;
  `,
};
