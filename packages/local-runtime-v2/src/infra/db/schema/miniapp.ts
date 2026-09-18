import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const MINIAPP_STATE_TABLE_METADATA = {
  name: 'local_runtime_liveboard_state',
  columnDefinitions: [
    { name: 'plugin_id', type: 'TEXT', notNull: 1, defaultValue: null, primaryKeyOrdinal: 1 },
    {
      name: 'accepted_source_digest',
      type: 'TEXT',
      notNull: 1,
      defaultValue: null,
      primaryKeyOrdinal: 0,
    },
    { name: 'client_digest', type: 'TEXT', notNull: 1, defaultValue: null, primaryKeyOrdinal: 0 },
    { name: 'node_digest', type: 'TEXT', notNull: 1, defaultValue: null, primaryKeyOrdinal: 0 },
    {
      name: 'preferred_port',
      type: 'INTEGER',
      notNull: 0,
      defaultValue: null,
      primaryKeyOrdinal: 0,
    },
    { name: 'last_error_json', type: 'TEXT', notNull: 0, defaultValue: null, primaryKeyOrdinal: 0 },
    {
      name: 'updated_at_ms',
      type: 'INTEGER',
      notNull: 1,
      defaultValue: null,
      primaryKeyOrdinal: 0,
    },
  ],
  checks: [
    `length(trim(plugin_id)) > 0
      AND length(trim(accepted_source_digest)) > 0
      AND length(trim(client_digest)) > 0
      AND length(trim(node_digest)) > 0`,
    `preferred_port IS NULL
      OR (node_digest IS NOT NULL AND preferred_port BETWEEN 1024 AND 65535)`,
    `updated_at_ms >= 0`,
    `last_error_json IS NULL OR json_valid(last_error_json)`,
  ],
} as const;

export const miniAppStates = sqliteTable(
  MINIAPP_STATE_TABLE_METADATA.name,
  {
    pluginId: text('plugin_id').notNull().primaryKey(),
    acceptedSourceDigest: text('accepted_source_digest').notNull(),
    clientDigest: text('client_digest').notNull(),
    nodeDigest: text('node_digest').notNull(),
    preferredPort: integer('preferred_port'),
    lastErrorJson: text('last_error_json'),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [
    check(
      'local_runtime_liveboard_state_identity',
      sql`length(trim(${table.pluginId})) > 0
        AND length(trim(${table.acceptedSourceDigest})) > 0
        AND length(trim(${table.clientDigest})) > 0
        AND length(trim(${table.nodeDigest})) > 0`,
    ),
    check(
      'local_runtime_liveboard_state_port',
      sql`${table.preferredPort} IS NULL OR (${table.nodeDigest} IS NOT NULL
        AND ${table.preferredPort} BETWEEN 1024 AND 65535)`,
    ),
    check('local_runtime_liveboard_state_updated_at', sql`${table.updatedAtMs} >= 0`),
    check(
      'local_runtime_liveboard_state_error',
      sql`${table.lastErrorJson} IS NULL OR json_valid(${table.lastErrorJson})`,
    ),
  ],
);
