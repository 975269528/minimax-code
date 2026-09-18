import type { MigrationEntry } from '../../migrate.js';

/**
 * Older continuation rows retained the first physical Turn start timestamp.
 * Rebuild their display anchor from completed active Turn intervals so paused
 * wall-clock gaps do not inflate the query duration.
 */
export const migration: MigrationEntry = {
  version: 32,
  name: 'repair_query_continuation_duration',
  up: `
    WITH raw_query_roots AS (
      SELECT
        query.session_id,
        query.query_key,
        query.current_turn_id,
        CASE
          WHEN substr(query.query_key, 1, 5) = 'turn:'
            THEN substr(query.query_key, 6)
          WHEN instr(query.query_key, ':turn:') > 0
            THEN substr(query.query_key, instr(query.query_key, ':turn:') + 6)
          ELSE NULL
        END AS root_with_suffix
      FROM local_runtime_query_view_states AS query
      WHERE query.processing_finished_at_ms IS NOT NULL
    ),
    query_roots AS (
      SELECT
        raw.session_id,
        raw.query_key,
        raw.current_turn_id,
        CASE
          WHEN instr(raw.root_with_suffix, ':s:') > 0
            THEN substr(raw.root_with_suffix, 1, instr(raw.root_with_suffix, ':s:') - 1)
          ELSE raw.root_with_suffix
        END AS root_turn_id
      FROM raw_query_roots AS raw
    ),
    continuation_durations AS (
      SELECT
        query.session_id,
        query.query_key,
        sum(
          CASE
            WHEN segment.completed_at_ms > segment.accepted_at_ms
              THEN segment.completed_at_ms - segment.accepted_at_ms
            ELSE 0
          END
        ) AS active_duration_ms
      FROM query_roots AS query
      JOIN local_runtime_turn_ingress AS root
        ON root.session_id = query.session_id
       AND root.turn_id = query.root_turn_id
      JOIN local_runtime_turn_ingress AS current
        ON current.session_id = query.session_id
       AND current.turn_id = query.current_turn_id
      JOIN local_runtime_turn_ingress AS segment
        ON segment.session_id = query.session_id
       AND segment.source = 'turn'
       AND segment.accepted_at_ms >= root.accepted_at_ms
       AND segment.accepted_at_ms <= current.accepted_at_ms
       AND segment.completed_at_ms IS NOT NULL
       AND (
         segment.turn_id = query.root_turn_id
         OR (
           json_valid(segment.input_metadata_json)
           AND json_extract(segment.input_metadata_json, '$.hasContent') = 0
         )
       )
      WHERE query.root_turn_id IS NOT NULL
        AND query.current_turn_id <> query.root_turn_id
      GROUP BY query.session_id, query.query_key
    )
    UPDATE local_runtime_query_view_states
    SET processing_started_at_ms = processing_finished_at_ms - (
      SELECT duration.active_duration_ms
      FROM continuation_durations AS duration
      WHERE duration.session_id = local_runtime_query_view_states.session_id
        AND duration.query_key = local_runtime_query_view_states.query_key
    )
    WHERE processing_finished_at_ms IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM continuation_durations AS duration
        WHERE duration.session_id = local_runtime_query_view_states.session_id
          AND duration.query_key = local_runtime_query_view_states.query_key
          AND duration.active_duration_ms > 0
      );
  `,
};
