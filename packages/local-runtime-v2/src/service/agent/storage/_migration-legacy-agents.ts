import { eq, or } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { readLegacyHistoryNoticeCutoff } from '../../../infra/db/legacy-history-notice-cutoff.js';
import {
  createLegacyAgentSource,
  type LegacyAgentRow,
  type LegacyAgentTimestampRecovery,
} from '../../../infra/legacy-db/agent-source.js';
import { createLegacyOpencodeReadonlySource } from '../../../infra/legacy-db/readonly-source.js';
import type { LegacyOpencodeSourceManifest } from '../../../infra/legacy-db/model.js';
import { agents } from '../../../infra/db/schema/agents.js';
import { legacyMigrations } from '../../../infra/db/schema/legacy-session.js';
import { legacyMessages, messageRows } from '../../../infra/db/schema/messages.js';
import { sessions } from '../../../infra/db/schema/sessions.js';

export type { LegacyAgentTimestampRecovery } from '../../../infra/legacy-db/agent-source.js';

export type LegacyAgentImportResult =
  | {
      readonly status: 'skipped';
      readonly reason: 'source-missing' | 'table-missing' | 'target-nonempty';
    }
  | {
      readonly status: 'imported';
      readonly count: number;
      readonly recoveredTimestamps: {
        readonly count: number;
        readonly entries: readonly LegacyAgentTimestampRecovery[];
      };
    };

const SYSTEM_REMINDER_BLOCK =
  /<system-reminder\b[^>]*\/>|<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/giu;

export type FrozenLegacyHistoryNoticeCandidate = {
  readonly agentName: string;
  readonly candidateSessionId: string;
  readonly createdAtMs: number;
};

export type FrozenLegacyHistoryNoticeResolution =
  | { readonly status: 'eligible'; readonly sessionId: string }
  | { readonly status: 'ineligible' }
  | { readonly status: 'pending' };

type LegacyReadonlySource = ReturnType<typeof createLegacyOpencodeReadonlySource>;

type LegacySourceInspection = {
  readonly source: LegacyReadonlySource;
  readonly manifest: LegacyOpencodeSourceManifest;
};

/** A builtin-only bootstrap target may safely catch up under the storage lock. */
export function isLegacyAgentTargetBootstrapEligible(db: AppDb): boolean {
  return db
    .select({ creationSource: agents.creationSource })
    .from(agents)
    .all()
    .every((row) => row.creationSource === 'builtin');
}

/**
 * Import the old Agent table into an empty or builtin-bootstrap target. A
 * Custom/automatic target is authoritative; no marker, overwrite, upsert, or
 * dual-write path is introduced.
 *
 * Recognized timestamp value failures are recovered field-by-field using the
 * same fallback as NULL/missing metadata.  No source Agent row is discarded;
 * schema and unknown failures still propagate before target writes.
 */
export function importLegacyAgents(options: {
  readonly db: AppDb;
  readonly sourceDataDir: string;
}): LegacyAgentImportResult {
  if (!isLegacyAgentTargetBootstrapEligible(options.db)) {
    return { status: 'skipped', reason: 'target-nonempty' };
  }

  const sourceResult = createLegacyAgentSource(options.sourceDataDir).readAgents();
  if (sourceResult.status === 'missing') return { status: 'skipped', reason: 'source-missing' };
  if (sourceResult.status === 'table-missing') {
    return { status: 'skipped', reason: 'table-missing' };
  }
  // After the two early returns, only the 'ready' variant is reachable.  Use
  // an explicit structural type assertion (`Extract<…, { status: 'ready' }>`)
  // so the rest of the function sees the narrowed shape without relying on
  // TypeScript's multi-arm union inference through early returns.
  const readyResult = sourceResult as Extract<typeof sourceResult, { status: 'ready' }>;
  const sourceRows = readyResult.rows;
  const recoveries = readyResult.recoveries;
  if (sourceRows.length === 0) {
    return {
      status: 'imported',
      count: 0,
      recoveredTimestamps: { count: 0, entries: [] },
    };
  }

  const sourceRowsByName = sourceRows.map((row) => ({
    name: requireString(row.agent_name, 'agent_name'),
    targetRow: toTargetRow(row),
  }));

  return options.db.transaction(
    (tx) => {
      const beforeRows = tx
        .select({ name: agents.agentName, creationSource: agents.creationSource })
        .from(agents)
        .all();
      if (!beforeRows.every((row) => row.creationSource === 'builtin')) {
        return { status: 'skipped', reason: 'target-nonempty' } as const;
      }
      const beforeNames = new Set(beforeRows.map((row) => row.name));
      const rowsToImport = sourceRowsByName.filter(({ name }) => !beforeNames.has(name));
      if (rowsToImport.length > 0) {
        tx.insert(agents)
          .values(rowsToImport.map(({ targetRow }) => targetRow))
          .run();
      }

      const names = tx
        .select({ name: agents.agentName })
        .from(agents)
        .all()
        .map((row) => row.name);
      // SQLite's default BINARY collation orders UTF-8 bytes, while JS
      // String#sort orders UTF-16 code units (notably for U+E000/U+10000).
      // Verify the primary-key set instead of comparing two different sort
      // orders; the target PK also guarantees uniqueness.
      const expected = new Set([...beforeNames, ...rowsToImport.map(({ name }) => name)]);
      if (
        names.length !== beforeRows.length + rowsToImport.length ||
        names.length !== expected.size ||
        names.some((name) => !expected.has(name))
      ) {
        throw new Error('Legacy Agent import verification failed');
      }
      return {
        status: 'imported',
        count: rowsToImport.length,
        recoveredTimestamps: { count: recoveries.length, entries: recoveries },
      } as const;
    },
    { behavior: 'immediate' },
  );
}

/** Validate a single candidate for reuse by read APIs; keep pending when the old database is temporarily unreadable so it can be retried. */
export async function resolveFrozenLegacyHistoryNotice(options: {
  readonly db: AppDb;
  readonly sourceDataDir: string;
  readonly candidate: FrozenLegacyHistoryNoticeCandidate;
}): Promise<FrozenLegacyHistoryNoticeResolution> {
  const cutoffMs = readLegacyHistoryNoticeCutoff(options.db);
  if (cutoffMs === undefined) return { status: 'pending' };
  const local = resolveFrozenLegacyHistoryNoticeLocally({ ...options, cutoffMs });
  if (local.resolution) return local.resolution;
  const source = await inspectLegacySource(options.sourceDataDir);
  if (!source) return { status: 'pending' };
  return resolveSourceCandidate({
    source,
    agentName: options.candidate.agentName,
    candidateSessionId: options.candidate.candidateSessionId,
    targetSessionId: local.targetSessionId,
    cutoffMs,
  });
}

async function inspectLegacySource(
  sourceDataDir: string,
): Promise<LegacySourceInspection | undefined> {
  const source = createLegacyOpencodeReadonlySource({ sourceDataDir });
  try {
    return { source, manifest: await source.getSourceManifest() };
  } catch {
    return undefined;
  }
}

function resolveFrozenLegacyHistoryNoticeLocally(input: {
  readonly db: AppDb;
  readonly candidate: FrozenLegacyHistoryNoticeCandidate;
  readonly cutoffMs: number;
}): {
  readonly resolution: FrozenLegacyHistoryNoticeResolution | undefined;
  readonly targetSessionId: string;
} {
  const mappings = matchingLegacyMigrations(input.db, input.candidate.candidateSessionId);
  if (mappings.some((mapping) => mapping.status === 'deleted')) {
    return {
      resolution: { status: 'ineligible' },
      targetSessionId: input.candidate.candidateSessionId,
    };
  }
  const mapping = mappings.find((item) => item.status !== 'deleted');
  const targetSessionId = mapping?.localSessionId ?? input.candidate.candidateSessionId;
  const materialized = materializedTarget(input.db, input.candidate.agentName, targetSessionId);
  if (materialized === 'mismatched') {
    return { resolution: { status: 'ineligible' }, targetSessionId };
  }
  // An existing migration mapping proves this history was materialized. If its target is later missing, treat it as deleted; never resurrect it from the old database.
  if (mapping && materialized === 'missing') {
    return { resolution: { status: 'ineligible' }, targetSessionId };
  }
  if (
    materialized === 'available' &&
    hasRealUserConversation(input.db, targetSessionId, input.cutoffMs)
  ) {
    return { resolution: { status: 'eligible', sessionId: targetSessionId }, targetSessionId };
  }
  return { resolution: undefined, targetSessionId };
}

function matchingLegacyMigrations(db: AppDb, sessionId: string) {
  return db
    .select({
      legacySessionId: legacyMigrations.legacySessionId,
      localSessionId: legacyMigrations.localSessionId,
      status: legacyMigrations.status,
    })
    .from(legacyMigrations)
    .where(
      or(
        eq(legacyMigrations.legacySessionId, sessionId),
        eq(legacyMigrations.legacyDaemonSessionId, sessionId),
        eq(legacyMigrations.legacyFrameworkSessionId, sessionId),
        eq(legacyMigrations.localSessionId, sessionId),
      ),
    )
    .all();
}

function materializedTarget(
  db: AppDb,
  agentName: string,
  sessionId: string,
): 'available' | 'missing' | 'mismatched' {
  const session = db
    .select({
      agentName: sessions.agentName,
    })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .get();
  if (!session) return 'missing';
  if (session.agentName !== agentName) return 'mismatched';
  return 'available';
}

async function resolveSourceCandidate(input: {
  readonly source: LegacySourceInspection;
  readonly agentName: string;
  readonly candidateSessionId: string;
  readonly targetSessionId: string;
  readonly cutoffMs: number;
}): Promise<FrozenLegacyHistoryNoticeResolution> {
  if (!input.source.manifest.sourceSqliteExists) return { status: 'ineligible' };
  if (input.source.manifest.errors?.length) return { status: 'pending' };
  try {
    const session = await input.source.source.getSession(input.candidateSessionId);
    if (!session) return { status: 'ineligible' };
    if (session.agentName !== input.agentName || session.sessionType !== 'root') {
      return { status: 'ineligible' };
    }
    for await (const page of input.source.source.streamMessagePages(session.sessionId, 100)) {
      if (page.some((message) => isRealLegacyDisplayMessageBefore(message, input.cutoffMs))) {
        return { status: 'eligible', sessionId: input.targetSessionId };
      }
    }
    return { status: 'ineligible' };
  } catch {
    return { status: 'pending' };
  }
}

function hasRealUserConversation(db: AppDb, sessionId: string, cutoffMs: number): boolean {
  const materialized = db
    .select({
      role: messageRows.role,
      source: messageRows.source,
      dataJson: messageRows.dataJson,
      createdAtMs: messageRows.createdAtMs,
    })
    .from(messageRows)
    .where(eq(messageRows.sessionId, sessionId))
    .all();
  if (materialized.some((row) => isRealUserMessageBefore(row, cutoffMs))) return true;
  const legacy = db
    .select({ displayMessagesJson: legacyMessages.displayMessagesJson })
    .from(legacyMessages)
    .where(eq(legacyMessages.sessionId, sessionId))
    .get();
  if (!legacy) return false;
  let messages: unknown;
  try {
    messages = JSON.parse(legacy.displayMessagesJson);
  } catch {
    return false;
  }
  return (
    Array.isArray(messages) &&
    messages.some((message) => isRealLegacyDisplayMessageBefore(message, cutoffMs))
  );
}

function isRealUserMessageBefore(
  row: {
    readonly role: string | null;
    readonly source: string | null;
    readonly dataJson: string;
    readonly createdAtMs: number;
  },
  cutoffMs: number,
): boolean {
  if (row.createdAtMs > cutoffMs) return false;
  const data = parseRecord(row.dataJson);
  const role = normalizeMessageField(row.role) ?? normalizeMessageField(data?.role);
  if (role !== 'user') return false;
  const source = normalizeMessageField(row.source) ?? normalizeMessageField(data?.source);
  return !isSyntheticSource(source) && !isSystemReminderOnly(messageText(data));
}

function isRealLegacyDisplayMessageBefore(value: unknown, cutoffMs: number): boolean {
  if (!isRecord(value) || normalizeMessageField(value.role) !== 'user') return false;
  const createdAtMs = numericField(value, 'timestamp');
  if (createdAtMs === undefined || createdAtMs > cutoffMs) return false;
  return (
    !isSyntheticSource(normalizeMessageField(value.source)) &&
    !isSystemReminderOnly(messageText(value))
  );
}

function parseRecord(raw: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMessageField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function isSyntheticSource(source: string | undefined): boolean {
  return source === 'system' || source === 'tool' || source === 'greeting';
}

function isSystemReminderOnly(value: string | undefined): boolean {
  if (value === undefined) return false;
  let matched = false;
  const remaining = value.replace(SYSTEM_REMINDER_BLOCK, () => {
    matched = true;
    return '';
  });
  return matched && remaining.trim().length === 0;
}

function messageText(value: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (!value) return undefined;
  for (const key of ['msg_content', 'content', 'text'] as const) {
    const text = textValue(value[key]);
    if (text !== undefined) return text;
  }
  const message = value.message;
  if (typeof message === 'string') return message;
  if (!isRecord(message)) return undefined;
  for (const key of ['content', 'text'] as const) {
    const text = textValue(message[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!isRecord(item)) return [];
    const text = textValue(item.text) ?? textValue(item.content);
    return text === undefined ? [] : [text];
  });
  return parts.length > 0 ? parts.join('') : undefined;
}

function numericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value) || typeof value[key] !== 'number') return undefined;
  return Number.isSafeInteger(value[key]) ? value[key] : undefined;
}

function toTargetRow(row: LegacyAgentRow): typeof agents.$inferInsert {
  const frozenLegacyHistorySessionId = frozenLegacyRootCandidate(row.main_session_id);
  return {
    agentName: requireString(row.agent_name, 'agent_name'),
    agentRole: row.agent_role,
    frameworkType: requireString(row.framework_type, 'framework_type'),
    pid: nullableValue(row.pid),
    port: nullableValue(row.port),
    processAlive: nullableValue(row.process_alive),
    lastActiveAt: nullableValue(row.last_active_at),
    configSyncedHash: nullableValue(row.config_synced_hash),
    opencodeConfigHash: nullableValue(row.opencode_config_hash),
    mainSessionId: nullableValue(row.main_session_id),
    legacyHistorySessionId: frozenLegacyHistorySessionId,
    sourceProject: nullableValue(row.source_project),
    harnessSourceType: requireString(row.harness_source_type, 'harness_source_type'),
    creationSource: requireString(row.creation_source, 'creation_source'),
    encDisplayName: nullableValue(row.enc_display_name),
    encDescription: nullableValue(row.enc_description),
    encAvatar: nullableValue(row.enc_avatar),
    greetingSent: nullableValue(row.greeting_sent) ?? 0,
    starTimestamp: nullableValue(row.star_timestamp),
    pinned: nullableValue(row.pinned),
    pinnedAt: nullableValue(row.pinned_at),
    spawnedByDataDir: nullableValue(row.spawned_by_data_dir),
    createdAt: nullableValue(row.created_at) ?? 0,
    updatedAt: nullableValue(row.updated_at) ?? 0,
  } as typeof agents.$inferInsert;
}

function frozenLegacyRootCandidate(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Legacy Agent ${field} is invalid`);
  return value;
}

function nullableValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return value;
}
