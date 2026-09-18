import type { DatabaseLike } from '../db.js';

/** `im-pinned` is retained only to deserialize historical migration manifests. */
export type RootSessionDedupBasis = 'im-pinned' | 'agent-root' | 'freshest';

export interface RootSessionDedupEntry {
  agentName: string;
  keptSessionId: string;
  decisionBasis: RootSessionDedupBasis;
  demotedSessionIds: string[];
  bindingsRepinned: number;
  agentPointerUpdated: boolean;
}

export type RootSessionDedupLogFn = (event: string, payload: Record<string, unknown>) => void;

export interface RootSessionDedupInput {
  db: DatabaseLike;
  dataDir: string;
  nowMs: () => number;
  log: RootSessionDedupLogFn;
}

export interface RootSessionDedupResult {
  deduped: RootSessionDedupEntry[];
  errors: string[];
}

interface RootCandidate {
  sessionId: string;
  record: Record<string, unknown>;
  updatedAtMs: number;
  archived: boolean;
}

interface AgentRowState {
  exists: boolean;
  record?: Record<string, unknown>;
}

/**
 * Deduplicate dirty multi-root sessions: enforce the "one root session per
 * agent" invariant on the merged v2 SQLite database during the forward v2
 * migration.
 *
 * Dirty data (multiple `sessionType === 'root'` sessions for one agent) is
 * known to cause concurrent per-session artifact writes on Windows (EPERM)
 * and IM-vs-UI root divergence on macOS. This step picks a single keeper per
 * agent and demotes the rest to `branch` (non-destructive, reversible).
 *
 * Keeper priority (decreasing reliability):
 *   1. `agent-root` — `local_runtime_agents.record_json.rootSessionId` pointing
 *                     at a candidate.
 *   2. `freshest`   — the candidate with the largest `record_json.updatedAtMs`.
 *
 * `channel-bindings.yaml` remains a compatibility file, but its historical
 * `pinned` flag is deliberately opaque here: migration must not select a Root
 * from it or rewrite it.
 * All ties break on ascending sessionId lexicographic order so runs are
 * reproducible.
 *
 * Fully synchronous by design: it runs inside host construction, before any
 * controller/channel/greeting wiring, so the per-agent work is naturally
 * serial and finishes before the greeting `Promise.all` fan-out that used to
 * trip the multi-root EPERM path.
 */
export function dedupeRootSessionsSync(input: RootSessionDedupInput): RootSessionDedupResult {
  const { db, nowMs, log } = input;
  const deduped: RootSessionDedupEntry[] = [];
  const errors: string[] = [];

  if (!dedupTableExists(db, 'local_runtime_sessions')) {
    log('scan', { sessionsScanned: 0, agentsWithRoot: 0, multiRootAgents: 0 });
    return { deduped, errors };
  }

  const rows = db
    .prepare(
      'SELECT session_id AS sessionId, record_json AS recordJson FROM local_runtime_sessions',
    )
    .all() as Array<{ sessionId: string; recordJson: string }>;

  // Candidate set: pi-agent roots only, grouped by agent. Archived and hidden
  // roots stay in the candidate set on purpose — the IM route resolver lists
  // sessions with includeHidden and does not filter archived, so they fork
  // routing exactly like visible roots do.
  const groups = new Map<string, RootCandidate[]>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.recordJson);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`session-row-parse:${row.sessionId}:${message}`);
      log('error', { stage: 'session-row-parse', message: `${row.sessionId}: ${message}` });
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (parsed.runtime !== 'pi-agent' || parsed.sessionType !== 'root') continue;
    const agentName = parsed.agentName;
    if (typeof agentName !== 'string' || agentName.length === 0) continue;
    const candidates = groups.get(agentName) ?? [];
    candidates.push({
      sessionId: row.sessionId,
      record: parsed,
      updatedAtMs: typeof parsed.updatedAtMs === 'number' ? parsed.updatedAtMs : 0,
      archived: parsed.archived === true,
    });
    groups.set(agentName, candidates);
  }

  const multiRootAgents = [...groups.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .sort(([left], [right]) => (left < right ? -1 : 1));

  log('scan', {
    sessionsScanned: rows.length,
    agentsWithRoot: groups.size,
    multiRootAgents: multiRootAgents.length,
  });
  if (multiRootAgents.length === 0) return { deduped, errors };

  const agentsTableExists = dedupTableExists(db, 'local_runtime_agents');

  for (const [agentName, candidates] of multiRootAgents) {
    // Deterministic ordering: freshest first, ties on ascending sessionId.
    const ordered = [...candidates].sort(
      (a, b) => b.updatedAtMs - a.updatedAtMs || (a.sessionId < b.sessionId ? -1 : 1),
    );
    const candidateIds = new Set(ordered.map((candidate) => candidate.sessionId));
    const agentRow = readAgentRow(db, agentsTableExists, agentName, log, errors);

    const { keeperId, basis } = pickKeeper(ordered, candidateIds, agentRow);
    const keeper = ordered.find((candidate) => candidate.sessionId === keeperId)!;
    const demoted = ordered.filter((candidate) => candidate.sessionId !== keeperId);
    const demotedIds = demoted.map((candidate) => candidate.sessionId);

    log('decide', {
      agentName,
      candidates: ordered.map((candidate) => ({
        sessionId: candidate.sessionId,
        updatedAtMs: candidate.updatedAtMs,
        archived: candidate.archived,
      })),
      keeper: keeperId,
      basis,
      demoted: demotedIds,
    });

    // root-session-dedup-ledger-divergence: this bare-SQL demote deliberately
    // bypasses ledger event sourcing — no `session.metadata_updated` event is
    // recorded for the sessionType flip, so the session ledger still describes
    // the demoted session as a root. We equally deliberately do NOT touch
    // `local_runtime_session_projection_watermarks`: the watermark stays
    // consistent with the (unchanged) ledger tip, so if a staleness-gated
    // `repairSessionFromLedger` is ever enabled it will see projection ==
    // ledger and will NOT replay (and thereby resurrect) the demoted root.
    // Accepted trade-off for a self-contained, fully synchronous startup
    // migration step.
    for (const candidate of demoted) {
      const stamp = nowMs();
      candidate.record.sessionType = 'branch';
      candidate.record.updatedAtMs = stamp;
      db.prepare(
        'UPDATE local_runtime_sessions SET record_json = ?, updated_at_ms = ? WHERE session_id = ?',
      ).run(JSON.stringify(candidate.record), stamp, candidate.sessionId);
    }

    // Keeper normalization, aligned with the `replaceRootSession` promote
    // semantics minus the title rewrite: the keeper may carry a stale parent
    // pointer or archived flag. Only write when something actually changes.
    let keeperChanged = false;
    if (keeper.record.parentSessionId != null) {
      keeper.record.parentSessionId = null;
      keeperChanged = true;
    }
    if (keeper.record.archived !== false) {
      keeper.record.archived = false;
      keeperChanged = true;
    }
    if (keeperChanged) {
      db.prepare('UPDATE local_runtime_sessions SET record_json = ? WHERE session_id = ?').run(
        JSON.stringify(keeper.record),
        keeper.sessionId,
      );
    }

    // Agent root pointer. A missing agent row (e.g. the primary agent) is
    // fine: runtime `ensureRootSession` self-heals against a single root.
    let agentPointerUpdated = false;
    if (!agentRow.exists) {
      log('agent-pointer', { agentName, skipped: 'agent-row-missing' });
    } else if (agentRow.record) {
      const from =
        typeof agentRow.record.rootSessionId === 'string' ? agentRow.record.rootSessionId : null;
      if (from !== keeperId) {
        const stamp = nowMs();
        agentRow.record.rootSessionId = keeperId;
        agentRow.record.updatedAtMs = stamp;
        db.prepare(
          'UPDATE local_runtime_agents SET record_json = ?, updated_at_ms = ? WHERE name = ?',
        ).run(JSON.stringify(agentRow.record), stamp, agentName);
        agentPointerUpdated = true;
      }
      log('agent-pointer', { agentName, from, to: keeperId });
    }

    deduped.push({
      agentName,
      keptSessionId: keeperId,
      decisionBasis: basis,
      demotedSessionIds: demotedIds,
      // Retained for manifest compatibility; runtime no longer repins bindings.
      bindingsRepinned: 0,
      agentPointerUpdated,
    });
  }

  return { deduped, errors };
}

function pickKeeper(
  ordered: RootCandidate[],
  candidateIds: Set<string>,
  agentRow: AgentRowState,
): { keeperId: string; basis: RootSessionDedupBasis } {
  if (
    agentRow.record &&
    typeof agentRow.record.rootSessionId === 'string' &&
    candidateIds.has(agentRow.record.rootSessionId)
  ) {
    return { keeperId: agentRow.record.rootSessionId, basis: 'agent-root' };
  }
  // `ordered` is (updatedAtMs desc, sessionId asc), so the head is the
  // freshest candidate with a deterministic lexicographic tie-break.
  return { keeperId: ordered[0]!.sessionId, basis: 'freshest' };
}

function readAgentRow(
  db: DatabaseLike,
  agentsTableExists: boolean,
  agentName: string,
  log: RootSessionDedupLogFn,
  errors: string[],
): AgentRowState {
  if (!agentsTableExists) return { exists: false };
  const row = db
    .prepare('SELECT record_json AS recordJson FROM local_runtime_agents WHERE name = ?')
    .get(agentName) as { recordJson?: string } | undefined;
  if (!row || typeof row.recordJson !== 'string') return { exists: false };
  try {
    const parsed = JSON.parse(row.recordJson);
    if (!isRecord(parsed)) throw new Error('record_json is not an object');
    return { exists: true, record: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`agent-row-parse:${agentName}:${message}`);
    log('error', { stage: 'agent-row-parse', message: `${agentName}: ${message}` });
    return { exists: true };
  }
}

function dedupTableExists(db: DatabaseLike, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
