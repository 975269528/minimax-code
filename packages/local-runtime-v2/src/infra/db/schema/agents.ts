import { customType, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const dynamicAgentRole = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => 'INTEGER',
});

/**
 * Physical Agent table carried forward from `<dataDir>/sqlite.db`.
 *
 * This deliberately mirrors the legacy table one-for-one.  Agent role and
 * identity ciphertext stay un-normalized at this boundary so legacy numeric
 * and string role values, as well as ciphertext, round-trip unchanged.
 */
export const agents = sqliteTable(
  'agents',
  {
    agentName: text('agent_name').primaryKey(),
    agentRole: dynamicAgentRole('agent_role').notNull(),
    frameworkType: text('framework_type').notNull(),
    pid: integer('pid'),
    port: integer('port'),
    processAlive: integer('process_alive').default(0),
    lastActiveAt: integer('last_active_at'),
    configSyncedHash: text('config_synced_hash'),
    opencodeConfigHash: text('opencode_config_hash'),
    mainSessionId: text('main_session_id'),
    // Freeze legacy Root candidates in a one-time migration; new Agents do not infer this value from later sessions.
    legacyHistorySessionId: text('legacy_history_session_id'),
    sourceProject: text('source_project'),
    harnessSourceType: text('harness_source_type').notNull().default(''),
    creationSource: text('creation_source').notNull().default('manual'),
    encDisplayName: text('enc_display_name'),
    encDescription: text('enc_description'),
    encAvatar: text('enc_avatar'),
    greetingSent: integer('greeting_sent').notNull().default(0),
    starTimestamp: integer('star_timestamp'),
    pinned: integer('pinned').default(0),
    pinnedAt: integer('pinned_at'),
    spawnedByDataDir: text('spawned_by_data_dir'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_agents_source_project').on(table.sourceProject),
    index('idx_agents_process_state').on(table.frameworkType, table.processAlive),
  ],
);
