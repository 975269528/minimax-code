import { runInImmediateTransaction, type DatabaseLike } from './db.js';

export interface TurnDiffRetentionResult {
  readonly diffs: number;
  readonly journalRows: number;
  readonly rewindOperations: number;
}

const DEFAULT_BATCH_SIZE = 250;

/**
 * Removes one bounded batch of expired terminal data. A Session with an
 * unfinished rewind operation is retained in full so restart can resume it.
 */
export function pruneExpiredTurnDiffs(
  db: DatabaseLike,
  cutoffMs: number,
  batchSize: number = DEFAULT_BATCH_SIZE,
): TurnDiffRetentionResult {
  if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
    throw new TypeError('Turn diff retention cutoff must be a non-negative integer');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('Turn diff retention batch size must be a positive integer');
  }
  return runInImmediateTransaction(db, () => {
    const terminalTurns = `
      SELECT retention_queue.session_id, retention_queue.item_id AS turn_id
      FROM local_runtime_turn_diff_retention_queue AS retention_queue
      JOIN local_runtime_turn_diff_journal AS terminal_turn
        ON terminal_turn.session_id = retention_queue.session_id
       AND terminal_turn.turn_id = retention_queue.item_id
      WHERE retention_queue.entry_kind = 'turn'
        AND retention_queue.eligible_at_ms < ?
        AND terminal_turn.row_type = 'turn'
        AND terminal_turn.turn_status IN ('finalized', 'empty', 'failed', 'superseded')
        AND terminal_turn.finalized_at_ms IS NOT NULL
        AND terminal_turn.finalized_at_ms = retention_queue.eligible_at_ms
        AND NOT EXISTS (
          SELECT 1
          FROM local_runtime_turn_diff_rewind_operations AS pending_rewind
          WHERE pending_rewind.session_id = terminal_turn.session_id
            AND pending_rewind.receipt_json IS NULL
        )
      ORDER BY retention_queue.eligible_at_ms,
               retention_queue.session_id,
               retention_queue.item_id
      LIMIT ?`;
    const removedTools = db
      .prepare(
        `WITH expired_turns AS (${terminalTurns})
         DELETE FROM local_runtime_turn_diff_journal
         WHERE rowid IN (
           SELECT tool_row.rowid
           FROM expired_turns
           JOIN local_runtime_turn_diff_journal AS tool_row
             ON tool_row.session_id = expired_turns.session_id
            AND tool_row.turn_id = expired_turns.turn_id
           WHERE tool_row.row_type = 'tool'
         )`,
      )
      .run(cutoffMs, batchSize) as { changes?: number };
    const removedTurns = db
      .prepare(
        `WITH expired_turns AS (${terminalTurns})
         DELETE FROM local_runtime_turn_diff_journal
         WHERE rowid IN (
           SELECT terminal_row.rowid
           FROM expired_turns
           JOIN local_runtime_turn_diff_journal AS terminal_row
             ON terminal_row.session_id = expired_turns.session_id
            AND terminal_row.turn_id = expired_turns.turn_id
           WHERE terminal_row.row_type = 'turn'
         )`,
      )
      .run(cutoffMs, batchSize) as { changes?: number };
    const removedDiffs = db
      .prepare(
        `WITH expired_diffs AS (
           SELECT expired_diff.rowid
           FROM local_runtime_turn_diff_retention_queue AS retention_queue
           JOIN local_runtime_turn_diffs AS expired_diff
             ON expired_diff.session_id = retention_queue.session_id
            AND expired_diff.turn_id = retention_queue.item_id
           WHERE retention_queue.entry_kind = 'diff'
             AND retention_queue.eligible_at_ms < ?
             AND COALESCE(expired_diff.updated_at_ms, expired_diff.captured_at_ms) =
                 retention_queue.eligible_at_ms
             AND NOT EXISTS (
               SELECT 1
               FROM local_runtime_turn_diff_journal AS pending_turn
               WHERE pending_turn.session_id = expired_diff.session_id
                 AND pending_turn.turn_id = expired_diff.turn_id
                 AND pending_turn.row_type = 'turn'
                 AND pending_turn.turn_status = 'pending'
             )
             AND NOT EXISTS (
               SELECT 1
               FROM local_runtime_turn_diff_rewind_operations AS pending_rewind
               WHERE pending_rewind.session_id = expired_diff.session_id
                 AND pending_rewind.receipt_json IS NULL
             )
           ORDER BY retention_queue.eligible_at_ms,
                    retention_queue.session_id,
                    retention_queue.item_id
           LIMIT ?
         )
         DELETE FROM local_runtime_turn_diffs
         WHERE rowid IN (SELECT rowid FROM expired_diffs)`,
      )
      .run(cutoffMs, batchSize) as { changes?: number };
    const removedRewinds = db
      .prepare(
        `WITH expired_rewinds AS (
           SELECT expired_rewind.rowid
           FROM local_runtime_turn_diff_retention_queue AS retention_queue
           JOIN local_runtime_turn_diff_rewind_operations AS expired_rewind
             ON expired_rewind.session_id = retention_queue.session_id
            AND expired_rewind.operation_id = retention_queue.item_id
           WHERE retention_queue.entry_kind = 'rewind'
             AND retention_queue.eligible_at_ms < ?
             AND expired_rewind.receipt_json IS NOT NULL
             AND expired_rewind.updated_at_ms = retention_queue.eligible_at_ms
           ORDER BY retention_queue.eligible_at_ms,
                    retention_queue.session_id,
                    retention_queue.item_id
           LIMIT ?
         )
         DELETE FROM local_runtime_turn_diff_rewind_operations
         WHERE rowid IN (SELECT rowid FROM expired_rewinds)`,
      )
      .run(cutoffMs, batchSize) as { changes?: number };
    return {
      diffs: numericOrZero(removedDiffs.changes),
      journalRows: numericOrZero(removedTools.changes) + numericOrZero(removedTurns.changes),
      rewindOperations: numericOrZero(removedRewinds.changes),
    };
  });
}

function numericOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
