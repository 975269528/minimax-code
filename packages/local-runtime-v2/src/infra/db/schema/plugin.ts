import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const pluginOfficialStates = sqliteTable(
  'local_runtime_plugin_official_state',
  {
    principalId: text('principal_id').notNull(),
    deployment: text('deployment').notNull(),
    stateJson: text('state_json').notNull(),
    updatedAtMs: integer('updated_at_ms').notNull(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.deployment] })],
);

export const pluginDisabledLocalRoots = sqliteTable('local_runtime_plugin_local_disabled', {
  canonicalRoot: text('canonical_root').primaryKey(),
  updatedAtMs: integer('updated_at_ms').notNull(),
});
