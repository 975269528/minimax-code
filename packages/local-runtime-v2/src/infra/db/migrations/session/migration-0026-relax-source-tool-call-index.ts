import type { MigrationEntry } from '../../migrate.js';

/** A source-producing Tool Call may expose multiple Web/File resources. */
export const migration: MigrationEntry = {
  version: 26,
  name: 'relax_source_tool_call_index',
  up: `
    DROP INDEX idx_session_turn_resources_tool_call;
    CREATE INDEX idx_session_turn_resources_tool_call
      ON session_turn_resources(session_id, msg_id, tool_call_id);
  `,
};
