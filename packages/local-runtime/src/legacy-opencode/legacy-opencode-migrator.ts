import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import { type AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import crypto from 'node:crypto';

import type { LocalRuntimeAgentStore, LocalRuntimeMessageStore } from '../persistence/ports.js';
import { registerLocalAsset } from '../assets/store.js';
import type {
  LegacyMigrationRecord,
  SqliteLegacyMigrationStore,
} from '../persistence/migration/legacy-migration-store.js';
import type { LocalSessionController, LocalSessionRecord } from '../sessions/controller.js';
import type { LiveSessionWriter } from '../sessions/writer/index.js';
import {
  LegacyOpencodeStore,
  type LegacyOpencodeMessageScan,
  type LegacyOpencodeSessionRecord,
  type LegacyOpencodeSourceManifest,
} from './legacy-opencode-store.js';
import {
  checksumJson,
  isLegacyMissingMessageId,
  isLocalStoreSyntheticMessageId,
  mergeDisplayMessages,
  missingIdMessageFingerprint,
  prepareLegacyDisplayMessages,
  preferExistingDisplayMessages,
  sanitizeDisplayMessagesForImport,
} from './legacy-opencode-display-transforms.js';
import {
  countRowsAtOrBefore,
  filterPostMigrationMessages,
  isLegacyDisplayReady,
  isLegacyPiHistoryReady,
  needsV3Upgrade,
  readMessageTimestamp,
  regroupPiAgentMessages,
} from './legacy-opencode-migration-records.js';
import {
  convertNativeMessagesToPiHistory,
  filterCompactedNativeMessages,
  NATIVE_PI_HISTORY_CONVERTER_VERSION,
  type NativePiHistoryConversionResult,
  type PiHistoryGroup,
} from './legacy-opencode-native-conversion.js';
import { sanitizePiHistoryForMessages } from '../persistence/pi-history-sanitizer.js';
import {
  detectPostPiCompactionReplacement,
  type V3PostCompactionSkipReason,
} from './legacy-opencode-v3-upgrade.js';
import {
  DEFAULT_PI_SEED_STRATEGY,
  PI_SEED_MARKER_PREFIX,
  buildPiSeedHistory,
  type LegacyPiSeedResult,
  type LegacyPiSeedStrategyOptions,
} from './legacy-opencode-pi-seed.js';
import { logger } from '../common/logger.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';

export interface LegacyOpencodeMigratorOptions {
  legacyStore: LegacyOpencodeStore;
  migrationStore: SqliteLegacyMigrationStore;
  controller: LocalSessionController;
  messageStore?: LocalRuntimeMessageStore;
  sessionWriter: LiveSessionWriter;
  agentStore?: LocalRuntimeAgentStore;
  primaryAgentName: string;
  defaultWorkspaceDir: () => string;
  dataDir: () => string;
  onPinnedSessionMigrated?: (sessionId: string) => Promise<void>;
  piSeedStrategy?: Partial<LegacyPiSeedStrategyOptions>;
  nowMs?: () => number;
  /** Optional reporter for `legacy_migration_total{layer=discovery|materialize|messages}`. */
  metrics?: ModuleMetricsReporter;
}

export interface LegacyOpencodeMigrationResult {
  session?: LocalSessionRecord;
  record?: LegacyMigrationRecord;
}

export interface MigrateSessionOptions {
  includeMessages?: boolean;
  includePiHistory?: boolean;
  /**
   * Force materialization of the local pi-agent session row + agent row
   * even when we are not importing messages / pi-history. Set by
   * on-demand paths (e.g. `resolveLocalSessionById`) that need a real
   * local row to hang mutations off. Implicitly true when
   * `includeMessages` or `includePiHistory` is set.
   *
   * When false (the default), and no message/pi-history import is
   * requested, migrateSession runs in **discovery-only** mode: it
   * upserts a `status='discovered'` migration record and returns
   * immediately, without touching the session controller, agent store,
   * or message store. This keeps list endpoints (`GET /agent/:name/
   * session[/tree]`) bounded by a per-legacy upsert instead of a per-
   * legacy create-session + agent + O(N) root-resolution SQLite write
   * chain. Any subsequent read/mutation on the local id lazily
   * materializes via this same method with `materialize: true`.
   */
  materialize?: boolean;
}

export type { LegacyPiSeedStrategyOptions } from './legacy-opencode-pi-seed.js';

const LEGACY_PRIMARY_AGENT_NAME = 'main';
const AUTO_LEGACY_AGENT_DESCRIPTIONS = new Set([
  'Migrated legacy opencode agent',
  'Legacy opencode sessions pending local Pi migration',
]);

const LEGACY_MIGRATION_LOG_PREFIX = '[legacy-opencode-migration]';

/**
 * Batch bounds for the streamed display-only import path. Source messages are
 * read, transformed, and written in count- and byte-bounded chunks so peak
 * memory scales with the batch rather than the whole session history. Chosen as
 * a balance between transaction overhead (too small → many tiny writes) and
 * resident memory (too large → defeats the point). Not user-configurable.
 */
const LEGACY_DISPLAY_IMPORT_BATCH_SIZE = 250;
const LEGACY_DISPLAY_IMPORT_BATCH_BYTES = 8 * 1024 * 1024;

interface LegacyMessageMigrationStats {
  sourceMessageCount: number;
  importedMessageCount: number;
  sourceChecksum?: string;
  displayChecksum?: string;
  piHistoryStrategy?: string;
  /**
   * Version of the native converter that produced the pi-history rows.
   * Persisted alongside `piHistoryStrategy` so a bumped
   * `NATIVE_PI_HISTORY_CONVERTER_VERSION` can auto-detect stale
   * `native-*` records via `isLegacyPiHistoryReady` and re-run the
   * import. Undefined when the strategy was not native (`display-seed-*`,
   * `existing-seed-preserved`, `deferred`).
   */
  piHistoryConverterVersion?: number;
  displayReady?: boolean;
  piHistoryReady?: boolean;
  report?: unknown;
  warnings: string[];
  retryable?: boolean;
  /**
   * True when the pi-history import round intentionally did nothing
   * because the native source was missing / unreadable and the existing
   * pi-history still holds broken legacy rows we must not overwrite
   * with a display-seed fallback (see `buildPiHistory` fail-closed
   * branch and round-5 review). When set, `migrateSession` MUST preserve
   * every pi-history-related field on the existing record (migratedAtMs
   * watermark, strategy, converterVersion, status) so the next attempt
   * still sees the same stale-native state and can retry cleanly once
   * the source comes back. Warnings + report are merged in as
   * observability.
   */
  piHistoryFailClosed?: boolean;
}

export class LegacyOpencodeMigrationError extends Error {
  readonly record: LegacyMigrationRecord;
  override readonly cause: unknown;

  constructor(record: LegacyMigrationRecord, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Legacy opencode session migration failed: ${causeMessage}`);
    this.name = 'LegacyOpencodeMigrationError';
    this.record = record;
    this.cause = cause;
  }
}

export class LegacyOpencodeMigrator {
  private readonly legacyStore: LegacyOpencodeStore;
  private readonly migrationStore: SqliteLegacyMigrationStore;
  private readonly controller: LocalSessionController;
  private readonly messageStore?: LocalRuntimeMessageStore;
  private readonly sessionWriter: LiveSessionWriter;
  private readonly agentStore?: LocalRuntimeAgentStore;
  private readonly primaryAgentName: string;
  private readonly defaultWorkspaceDir: () => string;
  private readonly dataDir: () => string;
  private readonly onPinnedSessionMigrated?: (sessionId: string) => Promise<void>;
  private readonly piSeedStrategy: LegacyPiSeedStrategyOptions;
  private readonly nowMs: () => number;
  private readonly metrics?: ModuleMetricsReporter;
  private readonly agentRootRepairInProgress = new Set<string>();
  private sourceManifestPromise?: Promise<
    Awaited<ReturnType<LegacyOpencodeStore['getSourceManifest']>>
  >;

  constructor(options: LegacyOpencodeMigratorOptions) {
    this.legacyStore = options.legacyStore;
    this.migrationStore = options.migrationStore;
    this.controller = options.controller;
    this.messageStore = options.messageStore;
    this.sessionWriter = options.sessionWriter;
    this.agentStore = options.agentStore;
    this.primaryAgentName = options.primaryAgentName;
    this.defaultWorkspaceDir = options.defaultWorkspaceDir;
    this.dataDir = options.dataDir;
    this.onPinnedSessionMigrated = options.onPinnedSessionMigrated;
    this.piSeedStrategy = { ...DEFAULT_PI_SEED_STRATEGY, ...options.piSeedStrategy };
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.metrics = options.metrics;
  }

  private getCachedSourceManifest(): Promise<
    Awaited<ReturnType<LegacyOpencodeStore['getSourceManifest']>>
  > {
    this.sourceManifestPromise ??= this.legacyStore.getSourceManifest();
    return this.sourceManifestPromise;
  }

  async listLegacySessions(agentName?: string): Promise<LocalSessionRecord[]> {
    const sessions = await this.legacyStore.listSessions(agentName);
    if (agentName === this.primaryAgentName && agentName !== LEGACY_PRIMARY_AGENT_NAME) {
      const aliased = await this.legacyStore.listSessions(LEGACY_PRIMARY_AGENT_NAME);
      const seen = new Set(sessions.map((s) => s.sessionId));
      for (const s of aliased) {
        if (!seen.has(s.sessionId)) sessions.push(s);
      }
    }
    if (sessions.length === 0) return sessions;
    const deleted = await this.listDeletedLegacySessionIds();
    return sessions.filter((session) => !deleted.has(session.sessionId));
  }

  async getLegacyAgent(
    agentName: string,
  ): Promise<Awaited<ReturnType<LegacyOpencodeStore['getAgent']>>> {
    const agent = await this.legacyStore.getAgent(agentName);
    if (!agent && agentName === this.primaryAgentName && agentName !== LEGACY_PRIMARY_AGENT_NAME) {
      return this.legacyStore.getAgent(LEGACY_PRIMARY_AGENT_NAME);
    }
    return agent;
  }

  async migrateSession(
    legacySessionId: string,
    options: MigrateSessionOptions = {},
  ): Promise<LegacyOpencodeMigrationResult> {
    const layer =
      options.includeMessages || options.includePiHistory
        ? 'messages'
        : options.materialize
          ? 'materialize'
          : 'discovery';
    const startedMs = this.nowMs();
    try {
      const result = await this.migrateSessionInner(legacySessionId, options);
      this.metrics?.incr('legacy_migration_total', { layer, status: 'ok' });
      this.metrics?.latency('legacy_migration_duration_ms', this.nowMs() - startedMs, { layer });
      return result;
    } catch (err) {
      this.metrics?.incr('legacy_migration_total', { layer, status: 'error' });
      throw err;
    }
  }

  private async migrateSessionInner(
    legacySessionId: string,
    options: MigrateSessionOptions = {},
  ): Promise<LegacyOpencodeMigrationResult> {
    const startedAtMs = Date.now();
    const legacySession = await this.legacyStore.getSession(legacySessionId);
    const canonicalSessionId = legacySession?.sessionId ?? legacySessionId;
    const wantsMaterialize =
      Boolean(options.materialize) ||
      Boolean(options.includeMessages) ||
      Boolean(options.includePiHistory);
    logLegacyMigrationInfo(
      `start session=${formatLogValue(canonicalSessionId)} agent=${formatLogValue(
        legacySession?.agentName ?? 'unknown',
      )} includeMessages=${Boolean(options.includeMessages)} includePiHistory=${Boolean(
        options.includePiHistory,
      )} materialize=${wantsMaterialize}`,
    );
    const existingLocal = await this.controller.getSession(canonicalSessionId);
    const existingRecord = await this.migrationStore.getByLegacySessionId(canonicalSessionId);
    let sourceMessageScan: LegacyOpencodeMessageScan | undefined;
    let sourceManifest: Awaited<ReturnType<LegacyOpencodeStore['getSourceManifest']>> | undefined;
    let sourceSchemaFingerprint = existingRecord?.sourceSchemaFingerprint;
    let sourceMessageCount = existingRecord?.sourceMessageCount;
    if (existingRecord?.status === 'deleted') return {};
    if (existingRecord?.status === 'failed') {
      throw new LegacyOpencodeMigrationError(
        existingRecord,
        existingRecord.error ?? new Error('Previous legacy opencode session migration failed.'),
      );
    }

    // Discovery-only path: no local pi-agent row, no agent row, no message
    // import — just a fingerprint row so subsequent list calls short-circuit
    // and mutation calls know where to materialize from. Kept above the
    // main materialize block so a `metadata` / `migrated` record wins
    // without any extra work.
    if (!wantsMaterialize) {
      if (existingRecord) {
        return {
          ...(existingLocal ? { session: existingLocal } : {}),
          record: existingRecord,
        };
      }
      if (!legacySession) return {};
      const now = this.nowMs();
      const warnings = buildSessionStatusWarnings(legacySession);
      const record: LegacyMigrationRecord = {
        legacySessionId: legacySession.sessionId,
        localSessionId: legacySession.sessionId,
        legacyDaemonSessionId: legacySession.sessionId,
        legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: 'discovered',
        migratedAtMs: now,
        sourceUpdatedAtMs: legacySession.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(legacySession),
        ...(warnings.length ? { warnings } : {}),
      };
      await this.migrationStore.upsert(record);
      logLegacyMigrationInfo(
        `discovered session=${formatLogValue(
          legacySession.sessionId,
        )} totalElapsedMs=${Date.now() - startedAtMs}`,
      );
      return { record };
    }
    if (
      existingLocal?.runtime === 'pi-agent' &&
      existingRecord &&
      (!options.includeMessages || isLegacyDisplayReady(existingRecord)) &&
      (!options.includePiHistory || isLegacyPiHistoryReady(existingRecord))
    ) {
      const repairedSession = legacySession
        ? await this.repairUnsafeExistingSessionStatus(existingLocal, legacySession)
        : existingLocal;
      const repairedRecord = legacySession
        ? await this.repairSessionStatusWarnings(existingRecord, legacySession)
        : existingRecord;
      return { session: repairedSession, record: repairedRecord };
    }

    if (!legacySession) {
      // Phantom root detection: `canonicalSessionId` was referenced by a legacy
      // agent's `main_session_id` but has no row in the legacy `sessions` table.
      // During boot, the owning Agent Application materialises an
      // empty pi-agent root session using that ID. When the user opens this
      // session and `ensureMessagesMigrated` fires, `legacyStore.getSession`
      // returns undefined while `controller.getSession` returns the empty shell.
      // Without this branch, the migrator would silently return with zero
      // messages imported.
      //
      // Guard: only enter phantom fallback if the sessionId is actually referenced
      // in the legacy agents table as root/main_session_id. Without this check,
      // any newly created v2 root session (random UUID not in legacy) would
      // incorrectly trigger the fallback and import stale legacy messages.
      //
      // Origin guard: the v2 agent store and `legacyStore.getAgent` share the
      // same sqlite `agents` table, so `main_session_id` tracks EVERY runtime
      // root promotion (UI create, IM `/new` via `replaceRootSession`,
      // rotation). The reference check above therefore also matches
      // user-created roots, and without the origin check the migrator would
      // import stale legacy history into a brand-new conversation. Sessions
      // minted by explicit user action carry `origin: 'user'` and must never
      // receive the fallback; `'root-repair'` shells (boot repair of a
      // dangling `main_session_id`) and records predating the field (absent
      // origin) remain eligible.
      if (
        existingLocal?.runtime === 'pi-agent' &&
        existingLocal.sessionType === 'root' &&
        existingLocal.origin !== 'user' &&
        !existingRecord &&
        options.includeMessages
      ) {
        const legacyAgent = await this.getLegacyAgent(existingLocal.agentName);
        const isReferencedByLegacyAgent = legacyAgent?.rootSessionId === canonicalSessionId;
        if (isReferencedByLegacyAgent) {
          const realRoot = await this.resolvePhantomRootFallback(existingLocal);
          if (realRoot) {
            logLegacyMigrationInfo(
              `phantom-root-fallback session=${formatLogValue(
                canonicalSessionId,
              )} realRoot=${formatLogValue(realRoot.sessionId)} agent=${formatLogValue(
                existingLocal.agentName,
              )}`,
            );
            return this.migratePhantomRoot(existingLocal, realRoot, options);
          }
          logLegacyMigrationWarn(
            `phantom-root-no-fallback session=${formatLogValue(
              canonicalSessionId,
            )} agent=${formatLogValue(existingLocal.agentName)}`,
          );
        }
      }
      return existingLocal?.runtime === 'pi-agent'
        ? { session: existingLocal, record: existingRecord }
        : {};
    }

    try {
      const session =
        existingLocal?.runtime === 'pi-agent'
          ? existingLocal
          : await this.createMigratedSession(legacySession);

      const messagesNeedImport = Boolean(
        options.includeMessages && !isLegacyDisplayReady(existingRecord),
      );
      const piHistoryNeedImport = Boolean(
        options.includePiHistory && !isLegacyPiHistoryReady(existingRecord),
      );
      let messageStats: LegacyMessageMigrationStats | undefined;
      if (messagesNeedImport || piHistoryNeedImport) {
        sourceManifest = await this.getCachedSourceManifest();
        sourceSchemaFingerprint = readSourceSchemaFingerprint(sourceManifest);
        sourceMessageScan ??= await this.legacyStore.scanMessages(legacySession.sessionId);
        sourceMessageCount = sourceMessageScan.sourceCount;
        await this.backfillSessionRecordToLedger(session);
        messageStats = await this.migrateMessages(legacySession, sourceMessageScan, {
          importDisplay: messagesNeedImport,
          importPiHistory: piHistoryNeedImport,
          previousMigratedAtMs: existingRecord?.migratedAtMs,
        });
      }

      const now = this.nowMs();
      const displayImportCompleted = Boolean(messageStats?.displayReady && !messageStats.retryable);
      const piHistoryImportCompleted = Boolean(
        messageStats?.piHistoryReady && !messageStats.retryable,
      );
      // Fail-closed pi-history import (round-5 review): the migrator
      // deliberately did NOT touch pi-history because the native source
      // was missing while broken legacy rows still occupy the segment.
      // Every pi-history-related identity field on the record MUST
      // stay exactly as it was on `existingRecord` so the next attempt
      // still sees the same stale-native state. Only warnings + report
      // are merged in for observability. Also — and this is the
      // critical piece — we do NOT move the `migratedAtMs` watermark
      // forward, otherwise the next attempt would treat what were
      // "pre-migration legacy rows" as "post-migration continuation
      // rows" and permanently mis-classify the segment.
      const piHistoryFailClosed = Boolean(messageStats?.piHistoryFailClosed);
      const displayReady = displayImportCompleted
        ? now
        : (existingRecord?.displayReadyAtMs ?? existingRecord?.projectionReadyAtMs);
      const piHistoryReady = piHistoryImportCompleted
        ? now
        : (existingRecord?.piHistoryReadyAtMs ??
          (isLegacyPiHistoryReady(existingRecord)
            ? existingRecord?.projectionReadyAtMs
            : undefined));
      const projectionReady = displayReady;
      const ledgerImported =
        displayReady || piHistoryReady ? now : existingRecord?.ledgerImportedAtMs;
      const sessionWarnings = buildSessionStatusWarnings(legacySession);
      const record: LegacyMigrationRecord = {
        legacySessionId: legacySession.sessionId,
        localSessionId: session.sessionId,
        legacyDaemonSessionId: legacySession.sessionId,
        legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: piHistoryFailClosed
          ? (existingRecord?.status ?? 'metadata')
          : piHistoryReady || existingRecord?.status === 'migrated'
            ? 'migrated'
            : 'metadata',
        // Preserve the original watermark when the pi-history side
        // fail-closed (see comment above). Fresh migrations without an
        // existing record fall back to `now` unchanged.
        migratedAtMs: piHistoryFailClosed ? (existingRecord?.migratedAtMs ?? now) : now,
        sourceUpdatedAtMs: legacySession.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(legacySession),
        sourceSchemaFingerprint,
        sourceChecksum: messageStats?.sourceChecksum ?? existingRecord?.sourceChecksum,
        displayChecksum: messageStats?.displayChecksum ?? existingRecord?.displayChecksum,
        // When fail-closed, preserve the prior strategy / converterVersion
        // verbatim — `isLegacyPiHistoryConverterCurrent` must keep
        // reporting the same value so the next ensurePiHistoryMigrated
        // call still detects staleness and retries. Do NOT let a
        // display-seed fallback strategy leak in.
        piHistoryStrategy: piHistoryFailClosed
          ? existingRecord?.piHistoryStrategy
          : (messageStats?.piHistoryStrategy ?? existingRecord?.piHistoryStrategy),
        piHistoryConverterVersion: piHistoryFailClosed
          ? existingRecord?.piHistoryConverterVersion
          : (messageStats?.piHistoryConverterVersion ?? existingRecord?.piHistoryConverterVersion),
        sourceManifest: sourceManifest ?? existingRecord?.sourceManifest,
        sourceMessageCount: messageStats?.sourceMessageCount ?? sourceMessageCount,
        importedMessageCount:
          messageStats?.importedMessageCount ?? existingRecord?.importedMessageCount,
        report: mergeMigrationReport(existingRecord?.report, messageStats?.report, {
          preservePriorDisplay: !messagesNeedImport,
          preservePriorPiHistory: !piHistoryNeedImport || piHistoryFailClosed,
        }),
        warnings: mergeWarnings(existingRecord?.warnings, sessionWarnings, messageStats?.warnings),
        ...(ledgerImported ? { ledgerImportedAtMs: ledgerImported } : {}),
        ...(projectionReady ? { projectionReadyAtMs: projectionReady } : {}),
        ...(displayReady ? { displayReadyAtMs: displayReady } : {}),
        // On fail-closed, keep `piHistoryReadyAtMs` exactly as it was
        // on existingRecord (typically undefined for a stale native
        // record, since `isLegacyPiHistoryReady` returns false when the
        // converter version is out of date). The `piHistoryReady` local
        // computed above already reads through existingRecord, so this
        // branch is a belt-and-braces guard.
        ...(piHistoryFailClosed
          ? existingRecord?.piHistoryReadyAtMs
            ? { piHistoryReadyAtMs: existingRecord.piHistoryReadyAtMs }
            : {}
          : piHistoryReady
            ? { piHistoryReadyAtMs: piHistoryReady }
            : {}),
      };
      await this.migrationStore.upsert(record);
      logLegacyMigrationInfo(
        `done session=${formatLogValue(legacySession.sessionId)} status=${formatLogValue(
          record.status,
        )} sourceCount=${record.sourceMessageCount ?? 0} importedCount=${
          record.importedMessageCount ?? 0
        } displayReady=${Boolean(record.displayReadyAtMs)} piHistoryReady=${Boolean(
          record.piHistoryReadyAtMs,
        )} totalElapsedMs=${Date.now() - startedAtMs} warningsCount=${
          record.warnings?.length ?? 0
        }`,
      );
      await this.ensureLocalAgentForSession(session);
      return { session: (await this.controller.getSession(session.sessionId)) ?? session, record };
    } catch (err) {
      logLegacyMigrationWarn(
        `failed session=${formatLogValue(legacySession.sessionId)} err=${formatLogValue(
          formatWarningError(err),
        )} elapsedMs=${Date.now() - startedAtMs}`,
      );
      const record: LegacyMigrationRecord = {
        legacySessionId: legacySession.sessionId,
        localSessionId: legacySession.sessionId,
        legacyDaemonSessionId: legacySession.sessionId,
        legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: 'failed',
        migratedAtMs: this.nowMs(),
        sourceUpdatedAtMs: legacySession.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(legacySession),
        sourceSchemaFingerprint,
        sourceManifest: sourceManifest ?? existingRecord?.sourceManifest,
        sourceMessageCount: sourceMessageScan?.sourceCount ?? existingRecord?.sourceMessageCount,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      await this.migrationStore.upsert(record);
      throw new LegacyOpencodeMigrationError(record, err);
    }
  }

  async ensureMessagesMigrated(sessionId: string): Promise<void> {
    const record = await this.migrationStore.getByLocalSessionId(sessionId);
    if (isLegacyDisplayReady(record)) return;
    if (record?.status === 'failed') {
      throw new LegacyOpencodeMigrationError(
        record,
        record.error ?? new Error('Previous legacy opencode session migration failed.'),
      );
    }
    if (record?.status === 'deleted') return;
    await this.migrateSession(record?.legacySessionId ?? sessionId, { includeMessages: true });
  }

  async ensurePiHistoryMigrated(sessionId: string): Promise<void> {
    const record = await this.migrationStore.getByLocalSessionId(sessionId);
    if (isLegacyPiHistoryReady(record)) return;
    if (record?.status === 'failed') {
      throw new LegacyOpencodeMigrationError(
        record,
        record.error ?? new Error('Previous legacy opencode session migration failed.'),
      );
    }
    if (record?.status === 'deleted') return;
    // v3 upgrade — binary decision (see plan §M3):
    //   scenario A (legacyRowsNow > 0, no compaction artifact)
    //             → full re-migrate legacy segment
    //   scenario B (legacyRowsNow == 0, or pi-agent compaction artifact)
    //             → no-op stamp v3 (pi-history has already been
    //               wholesale replaced by pi-agent compaction; do NOT
    //               resurrect)
    //   scenario D (existing rows == 0) → fresh migration
    //
    // Only take the scenario-B shortcut when the record is a `native-*`
    // strategy stamped by an older converter — the only case that
    // triggered this call in the first place — and pi-history either
    // sits wholly after the previous migration watermark or starts
    // with an explicit pi-agent compaction artifact. If we cannot tell
    // (no watermark on the record, or messageStore isn't wired), fall
    // through to the regular migrate path so the caller's semantics
    // stay intact.
    if (this.messageStore && needsV3Upgrade(record)) {
      const existingRows = await this.messageStore.getPiHistory(sessionId);
      if (existingRows.length > 0) {
        const migratedAtMs = record?.migratedAtMs;
        if (typeof migratedAtMs === 'number' && Number.isFinite(migratedAtMs)) {
          const legacyRowsNow = countRowsAtOrBefore(existingRows, migratedAtMs);
          const postCompactionReason = detectPostPiCompactionReplacement(
            existingRows,
            legacyRowsNow,
          );
          if (postCompactionReason) {
            await this.stampV3PostCompactionSkip(
              record!,
              existingRows.length,
              legacyRowsNow,
              postCompactionReason,
            );
            return;
          }
        }
      }
    }
    await this.migrateSession(record?.legacySessionId ?? sessionId, {
      includeMessages: true,
      includePiHistory: true,
    });
  }

  /**
   * Scenario B (see §M3): pi-history has already been fully replaced
   * by pi-agent-side compaction after the original migration wrote its
   * legacy segment. Do NOT resurrect the legacy content — pi-agent
   * runtime is the source of truth for that shape now. Stamp
   * `piHistoryConverterVersion = 3` and leave the rows alone.
   */
  private async stampV3PostCompactionSkip(
    record: LegacyMigrationRecord,
    existingRowCount: number,
    legacyRowsNow: number,
    reason: V3PostCompactionSkipReason,
  ): Promise<void> {
    const priorReport =
      record.report && typeof record.report === 'object' && !Array.isArray(record.report)
        ? (record.report as Record<string, unknown>)
        : {};
    const priorPiHistoryReport =
      priorReport['piHistory'] &&
      typeof priorReport['piHistory'] === 'object' &&
      !Array.isArray(priorReport['piHistory'])
        ? (priorReport['piHistory'] as Record<string, unknown>)
        : {};
    const upgraded: LegacyMigrationRecord = {
      ...record,
      migratedAtMs: this.nowMs(),
      piHistoryConverterVersion: NATIVE_PI_HISTORY_CONVERTER_VERSION,
      warnings: mergeWarnings(record.warnings, [
        `legacy_v3_skipped_post_pi_compaction:${existingRowCount}`,
      ]),
      report: {
        ...priorReport,
        piHistory: {
          ...priorPiHistoryReport,
          v3UpgradeDecision: 'skipped-post-pi-compaction',
          v3UpgradeDetail: {
            legacyRowsNow,
            preservedContinuationRows: existingRowCount,
            reason,
          },
        },
      },
    };
    await this.migrationStore.upsert(upgraded);
    logLegacyMigrationInfo(
      `v3-upgrade session=${formatLogValue(
        record.localSessionId,
      )} decision=skipped-post-pi-compaction legacyRowsNow=${legacyRowsNow} preservedContinuation=${existingRowCount} reason=${reason}`,
    );
  }

  async getMigrationRecordForLocalSession(
    sessionId: string,
  ): Promise<LegacyMigrationRecord | undefined> {
    return this.migrationStore.getByLocalSessionId(sessionId);
  }

  async getMigrationRecordForLegacySession(
    sessionId: string,
  ): Promise<LegacyMigrationRecord | undefined> {
    return this.migrationStore.getByLegacySessionId(sessionId);
  }

  async listMigrationRecords(): Promise<LegacyMigrationRecord[]> {
    return this.migrationStore.listAll();
  }

  async getSourceManifest(): Promise<
    Awaited<ReturnType<LegacyOpencodeStore['getSourceManifest']>>
  > {
    return this.getCachedSourceManifest();
  }

  async markSessionDeleted(sessionId: string): Promise<LegacyMigrationRecord | undefined> {
    const existingRecord =
      (await this.migrationStore.getByLocalSessionId(sessionId)) ??
      (await this.migrationStore.getByLegacySessionId(sessionId));
    if (!existingRecord) return undefined;
    const record: LegacyMigrationRecord = {
      ...existingRecord,
      status: 'deleted',
      migratedAtMs: this.nowMs(),
      error: undefined,
    };
    await this.migrationStore.upsert(record);
    return record;
  }

  private async listDeletedLegacySessionIds(): Promise<Set<string>> {
    const records = await this.migrationStore.listAll();
    return new Set(
      records
        .filter((record) => record.status === 'deleted')
        .map((record) => record.legacySessionId),
    );
  }

  private async createMigratedSession(
    legacySession: LegacyOpencodeSessionRecord,
  ): Promise<LocalSessionRecord> {
    const session = await this.controller.createPiSession({
      sessionId: legacySession.sessionId,
      agentName: legacySession.agentName,
      workspaceDir: legacySession.workspaceDir || this.defaultWorkspaceDir(),
      sessionType: legacySession.sessionType,
      title: legacySession.title ?? null,
      parentSessionId: legacySession.parentSessionId ?? null,
      visibility: legacySession.visibility,
      purpose: legacySession.purpose,
      archived: legacySession.archived,
      status: normalizeMigratedStatus(legacySession.status, legacySession.legacyRawStatus),
      sessionOrigin: 'legacy-opencode',
      createdAtMs: legacySession.createdAtMs,
      updatedAtMs: legacySession.updatedAtMs,
    });
    if (legacySession.pinned) {
      await this.onPinnedSessionMigrated?.(session.sessionId);
    }
    await this.messageStore?.initSession(session.sessionId);
    return session;
  }

  private async repairSessionStatusWarnings(
    existingRecord: LegacyMigrationRecord,
    legacySession: LegacyOpencodeSessionRecord,
  ): Promise<LegacyMigrationRecord> {
    const warnings = mergeWarnings(
      existingRecord.warnings,
      buildSessionStatusWarnings(legacySession),
    );
    const sameWarnings =
      warnings?.length === existingRecord.warnings?.length &&
      warnings?.every((warning, index) => warning === existingRecord.warnings?.[index]);
    if (sameWarnings || (!warnings && !existingRecord.warnings)) return existingRecord;
    const repaired = { ...existingRecord, warnings };
    await this.migrationStore.upsert(repaired);
    return repaired;
  }

  private async repairUnsafeExistingSessionStatus(
    existingLocal: LocalSessionRecord,
    legacySession: LegacyOpencodeSessionRecord,
  ): Promise<LocalSessionRecord> {
    if (!isUnsafeResumableLegacyStatus(legacySession.legacyRawStatus ?? legacySession.status)) {
      return existingLocal;
    }
    if (existingLocal.status === 'interrupted') return existingLocal;
    return (
      (await this.controller.updateSession(existingLocal.sessionId, {
        status: 'interrupted',
        errorMessage:
          'Legacy session was imported from a non-terminal runtime state and is preserved as interrupted history.',
      })) ?? existingLocal
    );
  }

  private async backfillSessionRecordToLedger(session: LocalSessionRecord): Promise<void> {
    await this.sessionWriter.withSessionWriteLock(session.sessionId, async () => {
      const watermark = await this.sessionWriter.recordSessionMetadataUpdated(session);
      await this.sessionWriter.markProjectionWatermark(watermark);
    });
  }

  /**
   * Streamed, display-only import. Produces byte-for-byte the same persisted
   * display rows (and the same `displayChecksum`) as the array pipeline
   * (`prepareLegacyDisplayMessages` → `preferExistingDisplayMessages` →
   * `normalizeLegacyMessageAttachments` → `mergeDisplayMessages` →
   * `sanitizeDisplayMessagesForImport`), but runs the transforms per message
   * over streamed source pages so peak memory scales with the batch size
   * instead of the whole session history.
   *
   * Only valid when pi-history is NOT being imported in the same round —
   * pi-history conversion consumes the full display array, so streaming would
   * not lower the peak there and the caller keeps the array path.
   *
   * The global-dedup semantics of the array helpers are preserved exactly:
   *   - prepare: a per-run `seenBase` map rewrites duplicate source msg_ids and
   *     assigns synthetic ids to missing ones, in source order (index-based).
   *   - prefer: existing display rows win by msg_id; missing-id legacy rows are
   *     matched to existing synthetic rows by fingerprint, consuming each match
   *     once (`shift`).
   *   - merge tail: existing rows whose msg_id was never emitted are appended
   *     after the legacy stream, in existing order.
   * Building the existing-row indices still reads the already-migrated display
   * set once (as the array path did); the large legacy blob is what streams.
   */
  private async streamDisplayImport(
    sourceSessionId: string,
    targetSessionId: string,
    messageStore: LocalRuntimeMessageStore,
    scannedDuplicateSourceMsgIds?: readonly string[],
  ): Promise<{
    importedMessageCount: number;
    displayChecksum: string;
    duplicateMsgIdsRewritten: number;
    missingMsgIdsAssigned: number;
    duplicateSourceMsgIds: string[];
    warnings: string[];
    attachmentStats: { missing: number; copied: number; dataUrl: number };
    parsedCount: number;
  }> {
    const existingDisplayMessages = await messageStore.getDisplayMessages(targetSessionId);
    const existingById = new Map<string, AgentMessage>();
    for (const message of existingDisplayMessages) {
      if (message.msg_id) existingById.set(message.msg_id, message);
    }
    const existingSyntheticByFingerprint = new Map<string, AgentMessage[]>();
    for (const message of existingDisplayMessages) {
      if (!isLocalStoreSyntheticMessageId(message.msg_id)) continue;
      const fingerprint = missingIdMessageFingerprint(message);
      const matches = existingSyntheticByFingerprint.get(fingerprint) ?? [];
      matches.push(message);
      existingSyntheticByFingerprint.set(fingerprint, matches);
    }

    // First-pass dedup state, mirroring `prepareLegacyDisplayMessages`.
    const seenBase = new Map<string, number>();
    const duplicateSourceMsgIds = new Set(scannedDuplicateSourceMsgIds ?? []);
    let duplicateMsgIdsRewritten = 0;
    let missingMsgIdsAssigned = 0;
    let sourceIndex = 0;

    // `scanMessages` normally provides the COMPLETE duplicate-source-id set
    // before any prefer decision, combining source audit and dedup discovery in
    // one bounded pass. Keep the old pre-pass only for compatibility with test
    // doubles or alternate stores that omit the optional scan field.
    if (scannedDuplicateSourceMsgIds === undefined) {
      const dupSeen = new Map<string, number>();
      for await (const page of this.legacyStore.streamMessagePages(
        sourceSessionId,
        LEGACY_DISPLAY_IMPORT_BATCH_SIZE,
      )) {
        for (const message of page) {
          const original =
            typeof message.msg_id === 'string' && message.msg_id.trim()
              ? message.msg_id
              : undefined;
          if (!original) continue; // missing ids never collide (index-based synthetic ids)
          const count = dupSeen.get(original) ?? 0;
          dupSeen.set(original, count + 1);
          if (count > 0) duplicateSourceMsgIds.add(original);
        }
      }
    }

    // Merge-tail bookkeeping, mirroring `mergeDisplayMessages`: track which
    // msg_ids were emitted from the legacy stream so leftover existing rows can
    // be appended afterwards.
    const emittedMsgIds = new Set<string>();

    const attachmentStats = { missing: 0, copied: 0, dataUrl: 0 };
    const displayHash = crypto.createHash('sha256');
    // `checksumJson(messages)` hashes `JSON.stringify(array)` — reproduce that
    // exactly by feeding the array's JSON delimiters (`[`, `,`, `]`) around
    // each element's JSON so a streamed hash equals the whole-array hash.
    displayHash.update('[');
    let checksumCount = 0;
    let importedMessageCount = 0;
    let parsedCount = 0;

    const prepareOne = (message: AgentMessage): AgentMessage => {
      const original =
        typeof message.msg_id === 'string' && message.msg_id.trim() ? message.msg_id : undefined;
      const base = original ?? `legacy-missing-msg-id-${sourceIndex + 1}`;
      const count = seenBase.get(base) ?? 0;
      seenBase.set(base, count + 1);
      const index = sourceIndex;
      sourceIndex += 1;
      if (!original) {
        missingMsgIdsAssigned += 1;
        return { ...message, msg_id: `${base}-${checksumJson(message).slice(0, 12)}` };
      }
      if (count > 0) {
        duplicateMsgIdsRewritten += 1;
        duplicateSourceMsgIds.add(base);
        return { ...message, msg_id: `${base}__legacy_dup_${count + 1}_${index + 1}` };
      }
      return message;
    };

    const preferOne = (message: AgentMessage): AgentMessage => {
      if (message.msg_id) {
        const existing = duplicateSourceMsgIds.has(message.msg_id)
          ? undefined
          : existingById.get(message.msg_id);
        if (existing) return existing;
        if (isLegacyMissingMessageId(message.msg_id)) {
          const matches = existingSyntheticByFingerprint.get(missingIdMessageFingerprint(message));
          const match = matches?.shift();
          if (match) return match;
        }
      }
      return message;
    };

    const emit = (message: AgentMessage): { message: AgentMessage; bytes: number } => {
      if (message.msg_id) emittedMsgIds.add(message.msg_id);
      const [sanitized] = sanitizeDisplayMessagesForImport([message]);
      const finalMessage = sanitized ?? message;
      const serialized = JSON.stringify(finalMessage);
      if (checksumCount > 0) displayHash.update(',');
      displayHash.update(serialized);
      checksumCount += 1;
      importedMessageCount += 1;
      return { message: finalMessage, bytes: Buffer.byteLength(serialized, 'utf8') };
    };

    // Drive the streamed writer with an async generator that yields our
    // transformed batches, so ledger + message-store writes stay batched and
    // the streamed writer clears existing rows on its first batch. Because
    // `preferOne`/merge-tail reference the pre-existing rows, we snapshot them
    // into `existingById` / `existingDisplayMessages` above, so clearing is safe.
    // An arrow-bodied async generator keeps `this` lexical (no `this` alias).
    const transformedBatches = async function* (
      this: LegacyOpencodeMigrator,
    ): AsyncGenerator<AgentMessage[], void, void> {
      let batch: AgentMessage[] = [];
      let batchBytes = 0;
      const enqueue = (emitted: {
        message: AgentMessage;
        bytes: number;
      }): AgentMessage[] | undefined => {
        if (batch.length > 0 && batchBytes + emitted.bytes > LEGACY_DISPLAY_IMPORT_BATCH_BYTES) {
          const ready = batch;
          batch = [emitted.message];
          batchBytes = emitted.bytes;
          return ready;
        }
        batch.push(emitted.message);
        batchBytes += emitted.bytes;
        if (
          batch.length >= LEGACY_DISPLAY_IMPORT_BATCH_SIZE ||
          batchBytes >= LEGACY_DISPLAY_IMPORT_BATCH_BYTES
        ) {
          const ready = batch;
          batch = [];
          batchBytes = 0;
          return ready;
        }
        return undefined;
      };
      for await (const page of this.legacyStore.streamMessagePages(
        sourceSessionId,
        LEGACY_DISPLAY_IMPORT_BATCH_SIZE,
        LEGACY_DISPLAY_IMPORT_BATCH_BYTES,
      )) {
        parsedCount += page.length;
        const prepared = page.map(prepareOne);
        const preferred = prepared.map(preferOne);
        const normalized = await this.normalizeLegacyMessageAttachments(
          sourceSessionId,
          preferred,
          attachmentStats,
        );
        const emitted = normalized.map(emit);
        page.length = 0;
        prepared.length = 0;
        preferred.length = 0;
        normalized.length = 0;
        for (const message of emitted) {
          const ready = enqueue(message);
          if (ready) yield ready;
        }
      }
      // Merge tail: existing rows never emitted from the legacy stream, in
      // existing order (mirrors `mergeDisplayMessages`' trailing loop).
      for (const existingMessage of existingDisplayMessages) {
        if (existingMessage.msg_id && emittedMsgIds.has(existingMessage.msg_id)) continue;
        const ready = enqueue(emit(existingMessage));
        if (ready) yield ready;
      }
      if (batch.length > 0) yield batch;
    };

    await this.sessionWriter.importDisplayMessagesStreamed(
      targetSessionId,
      transformedBatches.call(this),
    );

    displayHash.update(']');
    const displayChecksum = displayHash.digest('hex');

    const warnings = [
      ...(duplicateMsgIdsRewritten > 0
        ? [`legacy_duplicate_msg_id_rewritten:${duplicateMsgIdsRewritten}`]
        : []),
      ...(missingMsgIdsAssigned > 0
        ? [`legacy_missing_msg_id_assigned:${missingMsgIdsAssigned}`]
        : []),
    ];

    return {
      importedMessageCount,
      displayChecksum,
      duplicateMsgIdsRewritten,
      missingMsgIdsAssigned,
      duplicateSourceMsgIds: [...duplicateSourceMsgIds],
      warnings,
      attachmentStats,
      parsedCount,
    };
  }

  private async migrateMessages(
    legacySession: LegacyOpencodeSessionRecord,
    sourceMessageScan: LegacyOpencodeMessageScan,
    options: {
      importDisplay: boolean;
      importPiHistory: boolean;
      previousMigratedAtMs?: number;
    },
  ): Promise<LegacyMessageMigrationStats> {
    if (!this.messageStore) {
      return {
        sourceMessageCount: sourceMessageScan.sourceCount,
        importedMessageCount: 0,
        sourceChecksum: sourceMessageScan.rawChecksum,
        warnings: ['legacy_messages_skipped:no_message_store'],
        retryable: true,
      };
    }
    // Fast path: display-only import (no pi-history this round) with a batched
    // message store. Stream the (potentially huge) legacy blob through a
    // per-message transform pipeline so peak memory scales with the batch size
    // rather than the whole session history. Pi-history conversion needs the
    // full display array, so it keeps the array path below.
    const canStreamDisplay =
      options.importDisplay &&
      !options.importPiHistory &&
      typeof this.messageStore.appendDisplayMessages === 'function';
    if (canStreamDisplay) {
      const displayStartedAtMs = Date.now();
      const streamed = await this.streamDisplayImport(
        legacySession.sessionId,
        legacySession.sessionId,
        this.messageStore,
        sourceMessageScan.duplicateSourceMsgIds,
      );
      logLegacyMigrationInfo(
        `display-import done session=${formatLogValue(legacySession.sessionId)} messages=${
          streamed.importedMessageCount
        } streamed=1 elapsedMs=${Date.now() - displayStartedAtMs}`,
      );
      const warnings = [
        ...streamed.warnings,
        ...buildMessageScanWarnings(sourceMessageScan),
        ...buildSessionStatusWarnings(legacySession),
        ...(streamed.attachmentStats.missing > 0
          ? [`legacy_attachment_missing_or_unreadable:${streamed.attachmentStats.missing}`]
          : []),
      ];
      const report = {
        sessionId: legacySession.sessionId,
        legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
        display: {
          sourceCount: sourceMessageScan.sourceCount,
          parsedCount: streamed.parsedCount,
          importedCount: streamed.importedMessageCount,
          duplicateMsgIdsRewritten: streamed.duplicateMsgIdsRewritten,
          missingMsgIdsAssigned: streamed.missingMsgIdsAssigned,
          ready: true,
        },
        piHistory: { strategy: 'deferred', importedMessages: 0, ready: false },
        attachments: streamed.attachmentStats,
        checksums: {
          sourceRaw: sourceMessageScan.rawChecksum,
          sourceParsed: sourceMessageScan.parsedChecksum,
          importedDisplay: streamed.displayChecksum,
        },
      };
      return {
        sourceMessageCount: sourceMessageScan.sourceCount,
        importedMessageCount: streamed.importedMessageCount,
        sourceChecksum: sourceMessageScan.rawChecksum,
        displayChecksum: streamed.displayChecksum,
        piHistoryStrategy: undefined,
        piHistoryConverterVersion: undefined,
        displayReady: true,
        piHistoryReady: false,
        piHistoryFailClosed: false,
        report,
        warnings,
      };
    }
    const attachmentStats = { missing: 0, copied: 0, dataUrl: 0 };
    const parsedMessages = options.importDisplay
      ? await this.legacyStore.listMessages(legacySession.sessionId)
      : [];
    const prepared = prepareLegacyDisplayMessages(parsedMessages);
    const existingDisplayMessages = await this.messageStore.getDisplayMessages(
      legacySession.sessionId,
    );
    const messages = options.importDisplay
      ? await this.normalizeLegacyMessageAttachments(
          legacySession.sessionId,
          preferExistingDisplayMessages(prepared.messages, existingDisplayMessages, {
            duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
          }),
          attachmentStats,
        )
      : existingDisplayMessages;
    if (options.importDisplay) {
      const displayStartedAtMs = Date.now();
      const mergedDisplayMessages = mergeDisplayMessages(messages, existingDisplayMessages, {
        duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
      });
      await this.sessionWriter.importDisplayMessages(
        legacySession.sessionId,
        sanitizeDisplayMessagesForImport(mergedDisplayMessages),
      );
      logLegacyMigrationInfo(
        `display-import done session=${formatLogValue(legacySession.sessionId)} messages=${
          mergedDisplayMessages.length
        } elapsedMs=${Date.now() - displayStartedAtMs}`,
      );
    }
    const existingPiHistory = await this.messageStore.getPiHistory(legacySession.sessionId);
    const piImport = options.importPiHistory
      ? await this.buildPiHistory(
          legacySession,
          messages,
          sourceMessageScan,
          existingPiHistory,
          options.previousMigratedAtMs,
        )
      : undefined;
    if (piImport) {
      const piHistoryStartedAtMs = Date.now();
      await this.sessionWriter.importPiHistory(legacySession.sessionId, piImport.messages);
      logLegacyMigrationInfo(
        `pi-history-import done session=${formatLogValue(
          legacySession.sessionId,
        )} strategy=${formatLogValue(piImport.strategy)} messages=${
          piImport.messages.length
        } elapsedMs=${Date.now() - piHistoryStartedAtMs}`,
      );
    }
    const warnings = [
      ...prepared.warnings,
      ...buildMessageScanWarnings(sourceMessageScan),
      ...buildSessionStatusWarnings(legacySession),
      ...(piImport?.warnings ?? []),
      ...(attachmentStats.missing > 0
        ? [`legacy_attachment_missing_or_unreadable:${attachmentStats.missing}`]
        : []),
    ];
    const report = {
      sessionId: legacySession.sessionId,
      legacyFrameworkSessionId: legacySession.legacyFrameworkSessionId,
      display: {
        sourceCount: sourceMessageScan.sourceCount,
        parsedCount: parsedMessages.length,
        importedCount: options.importDisplay ? messages.length : existingDisplayMessages.length,
        duplicateMsgIdsRewritten: prepared.duplicateMsgIdsRewritten,
        missingMsgIdsAssigned: prepared.missingMsgIdsAssigned,
        ready: options.importDisplay,
      },
      piHistory: piImport?.report ?? {
        strategy: options.importPiHistory ? 'existing-seed-preserved' : 'deferred',
        importedMessages: 0,
        ready: false,
      },
      attachments: attachmentStats,
      checksums: {
        sourceRaw: sourceMessageScan.rawChecksum,
        sourceParsed: sourceMessageScan.parsedChecksum,
        importedDisplay: checksumJson(messages),
      },
    };
    return {
      sourceMessageCount: sourceMessageScan.sourceCount,
      importedMessageCount: options.importDisplay
        ? messages.length
        : existingDisplayMessages.length,
      sourceChecksum: sourceMessageScan.rawChecksum,
      displayChecksum: checksumJson(messages),
      piHistoryStrategy:
        piImport?.strategy ?? (options.importPiHistory ? 'existing-seed-preserved' : undefined),
      piHistoryConverterVersion:
        piImport && piImport.strategy.startsWith('native-')
          ? NATIVE_PI_HISTORY_CONVERTER_VERSION
          : undefined,
      displayReady: options.importDisplay,
      piHistoryReady: Boolean(piImport && !piImport.retryable),
      piHistoryFailClosed: Boolean(piImport?.failClosed),
      report,
      warnings,
    };
  }

  /**
   * Variant of `migrateMessages` that reads from `sourceSession` but writes
   * the imported display / pi-history data under a different `targetSessionId`.
   * Used by phantom-root migration to avoid creating orphaned message copies
   * under the source session ID.
   */
  private async migrateMessagesInto(
    targetSessionId: string,
    sourceSession: LegacyOpencodeSessionRecord,
    sourceMessageScan: LegacyOpencodeMessageScan,
    options: { importDisplay: boolean; importPiHistory: boolean },
  ): Promise<LegacyMessageMigrationStats> {
    if (!this.messageStore) {
      return {
        sourceMessageCount: sourceMessageScan.sourceCount,
        importedMessageCount: 0,
        sourceChecksum: sourceMessageScan.rawChecksum,
        warnings: ['legacy_messages_skipped:no_message_store'],
        retryable: true,
      };
    }
    // Fast path: display-only import (no pi-history this round) with a batched
    // message store — same streaming rationale as `migrateMessages`, but source
    // and target session ids differ (phantom-root).
    const canStreamDisplay =
      options.importDisplay &&
      !options.importPiHistory &&
      typeof this.messageStore.appendDisplayMessages === 'function';
    if (canStreamDisplay) {
      const displayStartedAtMs = Date.now();
      const streamed = await this.streamDisplayImport(
        sourceSession.sessionId,
        targetSessionId,
        this.messageStore,
        sourceMessageScan.duplicateSourceMsgIds,
      );
      logLegacyMigrationInfo(
        `display-import done session=${formatLogValue(targetSessionId)} (source=${formatLogValue(
          sourceSession.sessionId,
        )}) messages=${streamed.importedMessageCount} streamed=1 elapsedMs=${
          Date.now() - displayStartedAtMs
        }`,
      );
      const warnings = [
        ...streamed.warnings,
        ...buildMessageScanWarnings(sourceMessageScan),
        ...buildSessionStatusWarnings(sourceSession),
        ...(streamed.attachmentStats.missing > 0
          ? [`legacy_attachment_missing_or_unreadable:${streamed.attachmentStats.missing}`]
          : []),
      ];
      const report = {
        sessionId: sourceSession.sessionId,
        targetSessionId,
        legacyFrameworkSessionId: sourceSession.legacyFrameworkSessionId,
        display: {
          sourceCount: sourceMessageScan.sourceCount,
          parsedCount: streamed.parsedCount,
          importedCount: streamed.importedMessageCount,
          duplicateMsgIdsRewritten: streamed.duplicateMsgIdsRewritten,
          missingMsgIdsAssigned: streamed.missingMsgIdsAssigned,
          ready: true,
        },
        piHistory: { strategy: 'deferred', importedMessages: 0, ready: false },
        attachments: streamed.attachmentStats,
        checksums: {
          sourceRaw: sourceMessageScan.rawChecksum,
          sourceParsed: sourceMessageScan.parsedChecksum,
          importedDisplay: streamed.displayChecksum,
        },
      };
      return {
        sourceMessageCount: sourceMessageScan.sourceCount,
        importedMessageCount: streamed.importedMessageCount,
        sourceChecksum: sourceMessageScan.rawChecksum,
        displayChecksum: streamed.displayChecksum,
        piHistoryStrategy: undefined,
        piHistoryConverterVersion: undefined,
        displayReady: true,
        piHistoryReady: false,
        piHistoryFailClosed: false,
        report,
        warnings,
      };
    }
    const attachmentStats = { missing: 0, copied: 0, dataUrl: 0 };
    const parsedMessages = options.importDisplay
      ? await this.legacyStore.listMessages(sourceSession.sessionId)
      : [];
    const prepared = prepareLegacyDisplayMessages(parsedMessages);
    const existingDisplayMessages = await this.messageStore.getDisplayMessages(targetSessionId);
    const messages = options.importDisplay
      ? await this.normalizeLegacyMessageAttachments(
          sourceSession.sessionId,
          preferExistingDisplayMessages(prepared.messages, existingDisplayMessages, {
            duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
          }),
          attachmentStats,
        )
      : existingDisplayMessages;
    if (options.importDisplay) {
      const displayStartedAtMs = Date.now();
      const mergedDisplayMessages = mergeDisplayMessages(messages, existingDisplayMessages, {
        duplicateSourceMsgIds: prepared.duplicateSourceMsgIds,
      });
      await this.sessionWriter.importDisplayMessages(
        targetSessionId,
        sanitizeDisplayMessagesForImport(mergedDisplayMessages),
      );
      logLegacyMigrationInfo(
        `display-import done session=${formatLogValue(
          targetSessionId,
        )} (source=${formatLogValue(sourceSession.sessionId)}) messages=${
          mergedDisplayMessages.length
        } elapsedMs=${Date.now() - displayStartedAtMs}`,
      );
    }
    const existingPiHistory = await this.messageStore.getPiHistory(targetSessionId);
    const piImport = options.importPiHistory
      ? await this.buildPiHistory(sourceSession, messages, sourceMessageScan, existingPiHistory)
      : undefined;
    if (piImport) {
      const piHistoryStartedAtMs = Date.now();
      await this.sessionWriter.importPiHistory(targetSessionId, piImport.messages);
      logLegacyMigrationInfo(
        `pi-history-import done session=${formatLogValue(
          targetSessionId,
        )} (source=${formatLogValue(sourceSession.sessionId)}) strategy=${formatLogValue(
          piImport.strategy,
        )} messages=${piImport.messages.length} elapsedMs=${Date.now() - piHistoryStartedAtMs}`,
      );
    }
    const warnings = [
      ...prepared.warnings,
      ...buildMessageScanWarnings(sourceMessageScan),
      ...buildSessionStatusWarnings(sourceSession),
      ...(piImport?.warnings ?? []),
      ...(attachmentStats.missing > 0
        ? [`legacy_attachment_missing_or_unreadable:${attachmentStats.missing}`]
        : []),
    ];
    const report = {
      sessionId: sourceSession.sessionId,
      targetSessionId,
      legacyFrameworkSessionId: sourceSession.legacyFrameworkSessionId,
      display: {
        sourceCount: sourceMessageScan.sourceCount,
        parsedCount: parsedMessages.length,
        importedCount: options.importDisplay ? messages.length : existingDisplayMessages.length,
        duplicateMsgIdsRewritten: prepared.duplicateMsgIdsRewritten,
        missingMsgIdsAssigned: prepared.missingMsgIdsAssigned,
        ready: options.importDisplay,
      },
      piHistory: piImport?.report ?? {
        strategy: options.importPiHistory ? 'existing-seed-preserved' : 'deferred',
        importedMessages: 0,
        ready: false,
      },
      attachments: attachmentStats,
      checksums: {
        sourceRaw: sourceMessageScan.rawChecksum,
        sourceParsed: sourceMessageScan.parsedChecksum,
        importedDisplay: checksumJson(messages),
      },
    };
    return {
      sourceMessageCount: sourceMessageScan.sourceCount,
      importedMessageCount: options.importDisplay
        ? messages.length
        : existingDisplayMessages.length,
      sourceChecksum: sourceMessageScan.rawChecksum,
      displayChecksum: checksumJson(messages),
      piHistoryStrategy:
        piImport?.strategy ?? (options.importPiHistory ? 'existing-seed-preserved' : undefined),
      piHistoryConverterVersion:
        piImport && piImport.strategy.startsWith('native-')
          ? NATIVE_PI_HISTORY_CONVERTER_VERSION
          : undefined,
      displayReady: options.importDisplay,
      piHistoryReady: Boolean(piImport && !piImport.retryable),
      piHistoryFailClosed: Boolean(piImport?.failClosed),
      report,
      warnings,
    };
  }

  private async normalizeLegacyMessageAttachments(
    legacySessionId: string,
    messages: AgentMessage[],
    stats?: { missing: number; copied: number; dataUrl: number },
  ): Promise<AgentMessage[]> {
    const normalized: AgentMessage[] = [];
    for (const message of messages) {
      if (!message.attachments?.length) {
        normalized.push(message);
        continue;
      }
      const attachments = [];
      for (const attachment of message.attachments) {
        if (attachment.asset_id || (!attachment.file_path && !attachment.data_url)) {
          attachments.push(attachment);
          continue;
        }
        try {
          const asset = await registerLocalAsset({
            dataDir: this.dataDir,
            fileName: attachment.file_name || 'attachment',
            mimeType: attachment.mime_type || 'application/octet-stream',
            sourcePath: attachment.file_path,
            dataUrl: attachment.data_url,
            sourceKind: 'legacy-migration',
            sessionId: legacySessionId,
            nowMs: this.nowMs,
          });
          if (attachment.data_url) stats && (stats.dataUrl += 1);
          else stats && (stats.copied += 1);
          attachments.push({
            ...attachment,
            file_path: asset.absolutePath,
            file_name: asset.fileName,
            mime_type: asset.mimeType,
            asset_id: asset.assetId,
            data_url: undefined,
          });
        } catch {
          stats && (stats.missing += 1);
          attachments.push(attachment);
        }
      }
      normalized.push({ ...message, attachments });
    }
    return normalized;
  }

  private async buildPiHistory(
    session: LegacyOpencodeSessionRecord,
    messages: AgentMessage[],
    sourceMessageScan: LegacyOpencodeMessageScan,
    existingPiHistory: PiAgentMessage[],
    /**
     * Watermark from the previous migration record (if any). Used to
     * distinguish v1/v2 converter output (rows with `timestamp <=
     * previousMigratedAtMs`) — which we are about to discard as broken
     * — from user-driven continued conversation rows written by the
     * real pi-agent runtime after the original migration completed
     * (`timestamp > previousMigratedAtMs`). Without this split the
     * compensation re-migration would silently wipe weeks of legitimate
     * user work on top of the legacy import.
     */
    previousMigratedAtMs?: number,
  ): Promise<LegacyPiSeedResult & { retryable?: boolean; failClosed?: boolean }> {
    if (hasPiSeedMarker(existingPiHistory, session.sessionId)) {
      logLegacyMigrationInfo(
        `pi-history strategy=existing-seed-preserved session=${formatLogValue(session.sessionId)}`,
      );
      return {
        messages: existingPiHistory,
        strategy: 'existing-seed-preserved',
        warnings: [],
        report: { strategy: 'existing-seed-preserved', importedMessages: 0, ready: true },
      };
    }
    const native = await this.buildNativePiHistory(session);
    if (native && native.nativeGroups.length > 0) {
      // v3 group-aware merge, replaces round-4's `sort by row-timestamp`
      // approach (see NATIVE_PI_HISTORY_CONVERTER_VERSION doc for the
      // full story). Two invariants held here:
      //
      //   1. **Native segment order is fixed by opencode semantics.**
      //      `filterCompactedNativeMessages` (M0) already emits
      //      `[compaction-user, summary, ...tail, ...post]` — the exact
      //      replay order opencode's own `filterCompacted` guarantees.
      //      The tail messages inside that slice carry older timestamps
      //      than `compaction-user`/`summary`, so a global sort by
      //      `leaderTimestamp` would re-order them to
      //      `[...tail, compaction-user, summary, ...post]` and
      //      undo the whole point of M0 — the migrated pi-history
      //      would no longer replay opencode's compact semantics.
      //      Therefore we NEVER sort inside the native segment.
      //   2. **Preserved continuation is timestamp-driven.** pi-agent
      //      runtime appends rows with wall-clock timestamps > the
      //      watermark, so sorting them by `leaderTimestamp` recovers
      //      chronological order even if a caller wrote them
      //      out-of-order (regression fixture for
      //      `mvs_b78d7432f8b54791898e81b8ede77f43` explicitly plants
      //      reversed rows). Native-segment `.timestamp` is always
      //      `<= migratedAtMs` while preserved `.timestamp` is
      //      strictly `> migratedAtMs`, so a plain `native ++ preserved`
      //      concat is monotonic across the boundary.
      //   3. **Within any group, order is fixed by construction.**
      //      The converter emits `[assistant, toolResult_1, ...,
      //      toolResult_N]` as one PiHistoryGroup;
      //      `regroupPiAgentMessages` on the preserved-continuation
      //      side also greedily binds a run of toolResults to the
      //      preceding assistant. Cross-segment concat / intra-
      //      preserved sort never re-orders rows inside a group —
      //      Messages-compatible `tool_use ↔ tool_result` adjacency stays
      //      intact regardless.
      //
      // Sanitizer scope: applies ONLY to the native segment (rows we
      // just built from opencode.db). preservedContinuation stays
      // untouched — pi-agent runtime owns its own shape, and we must
      // not drop content it wrote after the original migration.
      const sanitizedNative = sanitizePiHistoryForMessages(
        native.nativeGroups.flatMap((group) => group.messages),
        { tag: `migration:${session.sessionId}` },
      );
      const sanitizedNativeGroups = regroupPiAgentMessages(sanitizedNative.messages);
      const preservedContinuation = filterPostMigrationMessages(
        existingPiHistory,
        previousMigratedAtMs,
      );
      const preservedGroups = regroupPiAgentMessages(preservedContinuation);
      const droppedV1Rows = existingPiHistory.length - preservedContinuation.length;
      // Sort only WITHIN the preserved-continuation segment (stable
      // sort keeps intra-group order intact). Native segment keeps
      // whatever order M0 handed us — never re-sorted.
      const sortedPreservedGroups = [...preservedGroups].sort(
        (a, b) => a.leaderTimestamp - b.leaderTimestamp,
      );
      const mergedGroups = [...sanitizedNativeGroups, ...sortedPreservedGroups];
      const mergedMessages = mergedGroups.flatMap((group) => group.messages);
      logLegacyMigrationInfo(
        `pi-history strategy=${formatLogValue(native.strategy)} session=${formatLogValue(
          session.sessionId,
        )} nativeMessages=${readReportNumber(native.report, 'nativeMessages')} imported=${
          native.messages.length
        } preservedUserTurns=${preservedContinuation.length} droppedV1Rows=${droppedV1Rows}` +
          ` sanitizerDropped=${
            sanitizedNative.stats.orphanToolCallDropped +
            sanitizedNative.stats.orphanToolResultDropped +
            sanitizedNative.stats.reorderedPairDropped +
            sanitizedNative.stats.emptyAssistantDropped
          } compactionFilterWarnings=${native.compactionFilterWarnings.length}`,
      );
      return {
        ...native,
        messages: mergedMessages,
        warnings: [
          ...native.warnings,
          ...sanitizedNative.warnings,
          ...(droppedV1Rows > 0
            ? [`legacy_v1_tool_call_dropped_rows_replaced:${droppedV1Rows}`]
            : []),
          ...(preservedContinuation.length > 0
            ? [`legacy_user_continuation_preserved:${preservedContinuation.length}`]
            : []),
        ],
        report: {
          ...native.report,
          preservedUserMessages: preservedContinuation.length,
          droppedV1Rows,
          sanitizer: sanitizedNative.stats,
          compactionFilterWarnings: native.compactionFilterWarnings,
        },
      };
    }
    // Fail-closed guard for stale-native upgrade paths (round-5 review
    // P1). If we got here with a previous migration watermark AND the
    // existing pi-history still holds rows below that watermark, those
    // rows are the previous native-* migration's broken output (v1 shape
    // that dropped tool calls, or v2 shape that shuffled call/result
    // adjacency). Falling back to display-seed here would:
    //   1) leave the broken legacy rows in place ([...existingPiHistory,
    //      ...seed.messages] concat semantics),
    //   2) stamp `piHistoryStrategy = 'display-seed-*'` on the record,
    //   3) `isLegacyPiHistoryConverterCurrent` returns true for any
    //      non-native strategy → the record is treated as "current
    //      forever" and no future ensurePiHistoryMigrated call will
    //      ever re-try the native path,
    //   4) permanently lock the 400 in place with no recovery hook.
    // Instead we return `messages: []` (importPiHistoryUnlocked
    // early-returns on empty → existing pi-history rows are physically
    // untouched) + `failClosed: true` (the outer wrap preserves the
    // existing record's watermark / strategy / version so the next
    // ensurePiHistoryMigrated call still sees the stale-native state
    // and can retry once opencode.db comes back). Fresh migrations
    // (previousMigratedAtMs === undefined) and stale upgrades where
    // existingPiHistory holds no legacy rows still get the original
    // display-seed fallback — that path has no broken content to
    // preserve.
    const hasStaleLegacyRows =
      previousMigratedAtMs !== undefined &&
      existingPiHistory.some((row) => readMessageTimestamp(row) <= previousMigratedAtMs);
    if (hasStaleLegacyRows) {
      const fallbackReason = describeNativeFallbackReason(native);
      logLegacyMigrationWarn(
        `pi-history fail-closed session=${formatLogValue(
          session.sessionId,
        )} reason=${formatLogValue(fallbackReason)} legacyRowsPreserved=${
          existingPiHistory.length
        }`,
      );
      return {
        messages: [],
        strategy: 'native-degraded',
        warnings: [
          ...(native?.warnings ?? ['legacy_native_missing_or_unreadable']),
          `legacy_v3_upgrade_fail_closed:${fallbackReason}:${existingPiHistory.length}`,
        ],
        report: {
          strategy: 'native-degraded',
          v3UpgradeDecision: 'fail-closed-native-source-missing',
          v3UpgradeDetail: {
            previousMigratedAtMs,
            legacyRowsPreserved: existingPiHistory.length,
            nativeFallbackReason: fallbackReason,
          },
          ...(native?.report ? { nativeFailure: native.report } : {}),
        },
        retryable: true,
        failClosed: true,
      };
    }
    const seed = await buildPiSeedHistory({
      session,
      messages,
      sourceMessageScan,
      options: this.piSeedStrategy,
      dataDir: this.dataDir,
      nowMs: this.nowMs,
    });
    logLegacyMigrationInfo(
      `pi-history strategy=display-seed-${formatLogValue(
        seed.strategy,
      )} session=${formatLogValue(session.sessionId)} fallbackReason=${formatLogValue(
        describeNativeFallbackReason(native),
      )}`,
    );
    return {
      ...seed,
      strategy: `display-seed-${seed.strategy}`,
      messages: [...existingPiHistory, ...seed.messages],
      warnings: [
        ...(native?.warnings ?? ['legacy_native_missing_or_unreadable']),
        ...seed.warnings,
      ],
      report: {
        ...seed.report,
        strategy: `display-seed-${seed.strategy}`,
        degradedFromNative: true,
        ...(native?.report ? { nativeFailure: native.report } : {}),
      },
    };
  }

  private async buildNativePiHistory(session: LegacyOpencodeSessionRecord): Promise<
    | (LegacyPiSeedResult & {
        retryable?: boolean;
        nativeGroups: PiHistoryGroup[];
        compactionFilterWarnings: string[];
      })
    | undefined
  > {
    try {
      const native = await this.legacyStore.listNativeMessages(session);
      if (!native) return undefined;
      // M0 — mirror opencode's own `filterCompacted`: drop everything
      // before the last compaction's `tail_start_id`, keeping only
      // `[compaction-user, summary, ...tail, ...post]`. On uncompacted
      // sessions this is identity + zero warnings; on compacted ones it
      // avoids blowing pi-history past the model context window.
      const filtered = filterCompactedNativeMessages(native.messages);
      const converted = convertNativeMessagesToPiHistory(filtered.messages, this.nowMs);
      const convertedFlat = converted.groups.flatMap((group) => group.messages);
      if (convertedFlat.length === 0) {
        return {
          messages: [],
          strategy: 'native-degraded',
          warnings: [...native.warnings, ...filtered.warnings, 'legacy_native_conversion_empty'],
          report: {
            strategy: 'native-degraded',
            nativeMessages: native.messages.length,
            filteredMessages: filtered.messages.length,
            importedMessages: 0,
            losses: converted.losses,
            counts: converted.counts,
          },
          retryable: true,
          nativeGroups: [],
          compactionFilterWarnings: filtered.warnings,
        };
      }
      // Quality gate (see docs/opencode-to-pi-agent-migration.html §I8 +
      // 20260712 post-mortem `mvs_5e9f144c61d74d5d9a0cb748461e42a7`): if
      // the native scan saw tool-call parts but conversion produced zero
      // pi-agent toolCall blocks, the runtime would replay a
      // conversation full of "let me check X" prefaces with no tool
      // actions — the exact shape that starved MiniMax-M3 into
      // one-sentence stops. Rather than accept `native-degraded` with a
      // silent loss, we mark the result as retryable so
      // `buildPiHistory` falls through to `display-seed-*` (which at
      // least keeps the user's questions and the assistant's textual
      // answers coherent, at the cost of dropping tool traces). The
      // native `counts` and `warnings` are surfaced on the report so
      // ops still see the loss.
      const toolCallSourceLoss =
        converted.counts.source.toolCall > 0 && converted.counts.converted.toolCall === 0;
      const strategy = converted.degraded ? 'native-degraded' : 'native-full';
      if (toolCallSourceLoss) {
        return {
          messages: [],
          strategy: 'native-degraded',
          warnings: [
            ...native.warnings,
            ...filtered.warnings,
            ...converted.warnings,
            `legacy_native_tool_call_dropped_gate:${converted.counts.source.toolCall}`,
          ],
          report: {
            strategy: 'native-degraded',
            source: {
              kind: native.source.kind,
              schemaFingerprint: native.source.schemaFingerprint,
              nativeSessionId: native.nativeSessionId,
            },
            nativeMessages: native.messages.length,
            filteredMessages: filtered.messages.length,
            importedMessages: convertedFlat.length,
            losses: converted.losses,
            counts: converted.counts,
            qualityGateFailure: 'tool_call_dropped',
          },
          retryable: true,
          nativeGroups: [],
          compactionFilterWarnings: filtered.warnings,
        };
      }
      return {
        messages: convertedFlat,
        strategy,
        warnings: [...native.warnings, ...filtered.warnings, ...converted.warnings],
        report: {
          strategy,
          source: {
            kind: native.source.kind,
            schemaFingerprint: native.source.schemaFingerprint,
            nativeSessionId: native.nativeSessionId,
          },
          nativeMessages: native.messages.length,
          filteredMessages: filtered.messages.length,
          importedMessages: convertedFlat.length,
          losses: converted.losses,
          counts: converted.counts,
        },
        nativeGroups: converted.groups,
        compactionFilterWarnings: filtered.warnings,
      };
    } catch (err) {
      return {
        messages: [],
        strategy: 'native-degraded',
        warnings: [`legacy_native_conversion_failed:${formatWarningError(err)}`],
        report: { strategy: 'native-degraded', error: formatWarningError(err) },
        retryable: true,
        nativeGroups: [],
        compactionFilterWarnings: [],
      };
    }
  }

  private async ensureLocalAgentForSession(session: LocalSessionRecord): Promise<void> {
    if (!this.agentStore || session.agentName === this.primaryAgentName) return;
    const existing = await this.agentStore.get(session.agentName);
    const legacyAgent = await this.legacyStore.getAgent(session.agentName);
    const now = this.nowMs();
    if (existing) {
      const canBackfillLegacyMetadata = existing.creationSource === 'auto';
      const existingRoot = existing.rootSessionId
        ? await this.controller.getSession(existing.rootSessionId)
        : undefined;
      const validExistingRoot =
        existing.rootSessionId && existingRoot?.sessionType === 'root'
          ? existing.rootSessionId
          : '';
      const rootSessionId =
        validExistingRoot ||
        (canBackfillLegacyMetadata
          ? await this.resolveMigratedRootSessionId(
              session,
              legacyAgent?.rootSessionId || existing.rootSessionId,
            )
          : existing.rootSessionId ||
            (await this.resolveMigratedRootSessionId(session, legacyAgent?.rootSessionId)));
      await this.agentStore.upsert({
        ...existing,
        displayName: canBackfillLegacyMetadata
          ? backfillAutoDisplayName(
              existing.displayName,
              legacyAgent?.displayName,
              session.agentName,
            )
          : existing.displayName,
        description: canBackfillLegacyMetadata
          ? backfillAutoDescription(existing.description, legacyAgent?.description)
          : existing.description,
        avatar: canBackfillLegacyMetadata
          ? (existing.avatar ?? legacyAgent?.avatar)
          : existing.avatar,
        persona: canBackfillLegacyMetadata
          ? (existing.persona ?? legacyAgent?.persona)
          : existing.persona,
        systemPrompt: canBackfillLegacyMetadata
          ? (existing.systemPrompt ?? legacyAgent?.systemPrompt)
          : existing.systemPrompt,
        defaultWorkspaceDir: canBackfillLegacyMetadata
          ? backfillAutoDefaultWorkspaceDir(
              existing.defaultWorkspaceDir,
              legacyAgent?.defaultWorkspaceDir,
              session.workspaceDir,
              this.defaultWorkspaceDir(),
            )
          : existing.defaultWorkspaceDir,
        rootSessionId,
        updatedAtMs: Math.max(existing.updatedAtMs, session.updatedAtMs, now),
      });
      return;
    }
    const rootSessionId = await this.resolveMigratedRootSessionId(
      session,
      legacyAgent?.rootSessionId,
    );
    await this.agentStore.upsert({
      name: session.agentName,
      displayName: legacyAgent?.displayName ?? session.agentName,
      creationSource: 'auto',
      rootSessionId,
      createdAtMs: legacyAgent?.createdAtMs ?? session.createdAtMs,
      updatedAtMs: Math.max(session.updatedAtMs, now),
      defaultWorkspaceDir:
        legacyAgent?.defaultWorkspaceDir ?? session.workspaceDir ?? this.defaultWorkspaceDir(),
      description: legacyAgent?.description ?? 'Migrated legacy opencode agent',
      ...(legacyAgent?.avatar ? { avatar: legacyAgent.avatar } : {}),
      ...(legacyAgent?.persona ? { persona: legacyAgent.persona } : {}),
      ...(legacyAgent?.systemPrompt ? { systemPrompt: legacyAgent.systemPrompt } : {}),
    });
  }

  private async resolveMigratedRootSessionId(
    session: LocalSessionRecord,
    preferredRootSessionId?: string,
  ): Promise<string> {
    if (session.sessionType === 'root') return session.sessionId;
    if (this.agentRootRepairInProgress.has(session.agentName)) return '';
    const legacySessions = await this.legacyStore.listSessions(session.agentName);
    const preferredRoot = preferredRootSessionId
      ? legacySessions.find(
          (candidate) =>
            candidate.sessionType === 'root' &&
            (candidate.sessionId === preferredRootSessionId ||
              candidate.legacyFrameworkSessionId === preferredRootSessionId),
        )
      : undefined;
    const rootCandidates = [
      preferredRoot,
      ...legacySessions.filter(
        (candidate) =>
          candidate.sessionType === 'root' && candidate.sessionId !== preferredRoot?.sessionId,
      ),
    ].filter((candidate): candidate is LegacyOpencodeSessionRecord => Boolean(candidate));
    for (const legacyRoot of rootCandidates) {
      const existingRoot = await this.controller.getSession(legacyRoot.sessionId);
      if (existingRoot?.sessionType === 'root') return existingRoot.sessionId;
      this.agentRootRepairInProgress.add(session.agentName);
      try {
        // Metadata-only materialization: we need the legacy root's pi-agent
        // session row to exist in the controller so `controller.getSession`
        // below can retrieve it, but we deliberately skip message import.
        // `materialize: true` is required after discovery-only became the
        // default — without it this call would only upsert a
        // `status='discovered'` record and the controller would still return
        // undefined, causing `ensureLocalAgentForSession` to persist an
        // empty rootSessionId onto the agent and later create a fresh
        // empty root through `/agent/:name/session/root` while the real
        // legacy root history sits orphaned.
        await this.migrateSession(legacyRoot.sessionId, {
          materialize: true,
          includeMessages: false,
        });
      } catch {
        continue;
      } finally {
        this.agentRootRepairInProgress.delete(session.agentName);
      }
      const migratedRoot = await this.controller.getSession(legacyRoot.sessionId);
      if (migratedRoot?.sessionType === 'root') return migratedRoot.sessionId;
    }
    return '';
  }

  /**
   * For a phantom root session (exists in v2 but not in the legacy sessions
   * table), locate the agent's real legacy root session that actually contains
   * messages. Returns `undefined` when no usable fallback exists.
   */
  private async resolvePhantomRootFallback(
    phantomSession: LocalSessionRecord,
  ): Promise<LegacyOpencodeSessionRecord | undefined> {
    const agentName = phantomSession.agentName;
    // Reuse listLegacySessions which handles primaryAgent alias merging and
    // deleted-session filtering in one place.
    const liveSessions = (await this.listLegacySessions(
      agentName,
    )) as LegacyOpencodeSessionRecord[];
    if (liveSessions.length === 0) return undefined;

    // Prefer legacy roots; among roots pick the one with the most messages.
    const roots = liveSessions.filter((s) => s.sessionType === 'root');
    if (roots.length === 0) {
      logLegacyMigrationWarn(
        `phantom-root-fallback-from-branch session=${formatLogValue(
          phantomSession.sessionId,
        )} agent=${formatLogValue(agentName)} candidates=${liveSessions.length}`,
      );
    }
    let best: LegacyOpencodeSessionRecord | undefined;
    let bestCount = 0;
    for (const candidate of roots.length > 0 ? roots : liveSessions) {
      const scan = await this.legacyStore.scanMessages(candidate.sessionId);
      if (scan.sourceCount > bestCount) {
        best = candidate;
        bestCount = scan.sourceCount;
      }
    }
    return best;
  }

  /**
   * Import messages from a real legacy root session into a phantom root
   * session. The phantom session already exists in v2 as an empty pi-agent
   * root; we reuse it rather than redirecting the agent pointer so cached
   * session IDs in the UI stay valid.
   */
  private async migratePhantomRoot(
    phantomSession: LocalSessionRecord,
    realLegacyRoot: LegacyOpencodeSessionRecord,
    options: { includeMessages?: boolean; includePiHistory?: boolean },
  ): Promise<LegacyOpencodeMigrationResult> {
    const startedAtMs = Date.now();
    const sourceManifest = await this.getCachedSourceManifest();
    const sourceSchemaFingerprint = readSourceSchemaFingerprint(sourceManifest);
    const sourceMessageScan = await this.legacyStore.scanMessages(realLegacyRoot.sessionId);

    try {
      await this.backfillSessionRecordToLedger(phantomSession);

      // Phantom root is a one-shot special path — always import both display
      // and piHistory in one pass. This avoids the scenario where a first call
      // with includeMessages creates a record, then a second call with
      // includePiHistory skips the phantom branch (because the record exists)
      // and piHistory is never imported.
      const messagesNeedImport = true;
      const piHistoryNeedImport = true;
      let messageStats: LegacyMessageMigrationStats | undefined;
      if (messagesNeedImport || piHistoryNeedImport) {
        // Read messages from the real legacy root but write them directly
        // under the phantom session ID. This avoids creating orphaned copies
        // under realLegacyRoot.sessionId that would be re-processed if the
        // real root is later migrated normally.
        messageStats = await this.migrateMessagesInto(
          phantomSession.sessionId,
          realLegacyRoot,
          sourceMessageScan,
          {
            importDisplay: messagesNeedImport,
            importPiHistory: piHistoryNeedImport,
          },
        );
      }

      const now = this.nowMs();
      const displayImportCompleted = Boolean(messageStats?.displayReady && !messageStats.retryable);
      const piHistoryImportCompleted = Boolean(
        messageStats?.piHistoryReady && !messageStats.retryable,
      );
      const displayReady = displayImportCompleted ? now : undefined;
      const piHistoryReady = piHistoryImportCompleted ? now : undefined;
      const record: LegacyMigrationRecord = {
        legacySessionId: phantomSession.sessionId,
        localSessionId: phantomSession.sessionId,
        legacyDaemonSessionId: realLegacyRoot.sessionId,
        legacyFrameworkSessionId: realLegacyRoot.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: piHistoryReady ? 'migrated' : 'metadata',
        migratedAtMs: now,
        sourceUpdatedAtMs: realLegacyRoot.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(realLegacyRoot),
        sourceSchemaFingerprint,
        sourceChecksum: messageStats?.sourceChecksum,
        displayChecksum: messageStats?.displayChecksum,
        piHistoryStrategy: messageStats?.piHistoryStrategy,
        piHistoryConverterVersion: messageStats?.piHistoryConverterVersion,
        sourceManifest,
        sourceMessageCount: messageStats?.sourceMessageCount ?? sourceMessageScan.sourceCount,
        importedMessageCount: messageStats?.importedMessageCount,
        report: messageStats?.report,
        warnings: mergeWarnings(
          [`phantom_root_fallback:${realLegacyRoot.sessionId}`],
          messageStats?.warnings,
        ),
        ...(displayReady ? { displayReadyAtMs: displayReady } : {}),
        ...(piHistoryReady ? { piHistoryReadyAtMs: piHistoryReady } : {}),
        ...(displayReady ? { projectionReadyAtMs: displayReady } : {}),
        ...(displayReady || piHistoryReady ? { ledgerImportedAtMs: now } : {}),
      };
      await this.migrationStore.upsert(record);
      logLegacyMigrationInfo(
        `phantom-root-done session=${formatLogValue(
          phantomSession.sessionId,
        )} realRoot=${formatLogValue(realLegacyRoot.sessionId)} sourceCount=${
          record.sourceMessageCount ?? 0
        } importedCount=${record.importedMessageCount ?? 0} displayReady=${Boolean(
          record.displayReadyAtMs,
        )} piHistoryReady=${Boolean(
          record.piHistoryReadyAtMs,
        )} totalElapsedMs=${Date.now() - startedAtMs}`,
      );
      return { session: phantomSession, record };
    } catch (err) {
      logLegacyMigrationWarn(
        `phantom-root-failed session=${formatLogValue(
          phantomSession.sessionId,
        )} realRoot=${formatLogValue(realLegacyRoot.sessionId)} err=${formatLogValue(
          formatWarningError(err),
        )} elapsedMs=${Date.now() - startedAtMs}`,
      );
      const record: LegacyMigrationRecord = {
        legacySessionId: phantomSession.sessionId,
        localSessionId: phantomSession.sessionId,
        legacyDaemonSessionId: realLegacyRoot.sessionId,
        legacyFrameworkSessionId: realLegacyRoot.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: 'failed',
        migratedAtMs: this.nowMs(),
        sourceUpdatedAtMs: realLegacyRoot.updatedAtMs,
        sourceFingerprint: buildSourceFingerprint(realLegacyRoot),
        sourceSchemaFingerprint,
        sourceManifest,
        sourceMessageCount: sourceMessageScan.sourceCount,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      await this.migrationStore.upsert(record);
      throw new LegacyOpencodeMigrationError(record, err);
    }
  }
}

function formatWarningError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, '_').slice(0, 160);
}

function logLegacyMigrationInfo(message: string): void {
  logger.info({ prefix: LEGACY_MIGRATION_LOG_PREFIX, message }, 'Legacy opencode migration info');
}

function logLegacyMigrationWarn(message: string): void {
  logger.warn(
    { prefix: LEGACY_MIGRATION_LOG_PREFIX, message },
    'Legacy opencode migration warning',
  );
}

function formatLogValue(value: unknown): string {
  return String(value).replace(/\s+/g, '_').slice(0, 200);
}

function readReportNumber(report: Record<string, unknown>, key: string): number {
  const value = report[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function describeNativeFallbackReason(
  native: (LegacyPiSeedResult & { retryable?: boolean }) | undefined,
): string {
  if (!native) return 'native-missing';
  if (native.report && typeof native.report === 'object') {
    const report = native.report as Record<string, unknown>;
    if (typeof report.qualityGateFailure === 'string') {
      return `native-quality-gate:${report.qualityGateFailure}`;
    }
    if ('error' in report) {
      return `native-error:${formatLogValue(report.error)}`;
    }
  }
  return 'native-empty';
}

function hasPiSeedMarker(messages: PiAgentMessage[], sessionId: string): boolean {
  const marker = `${PI_SEED_MARKER_PREFIX}${sessionId}`;
  return messages.some((message) => JSON.stringify(message).includes(marker));
}

function normalizeMigratedStatus(
  status: LocalSessionRecord['status'],
  rawStatus?: string | null,
): LocalSessionRecord['status'] {
  return isUnsafeResumableLegacyStatus(rawStatus ?? status) ? 'interrupted' : status;
}

function buildSourceFingerprint(session: LegacyOpencodeSessionRecord): string {
  return checksumJson({
    sessionId: session.sessionId,
    legacyFrameworkSessionId: session.legacyFrameworkSessionId,
    updatedAtMs: session.updatedAtMs,
    status: session.status,
    legacyRawStatus: session.legacyRawStatus,
  });
}

function isUnsafeResumableLegacyStatus(status: string | null | undefined): boolean {
  const normalized = status?.trim().toLowerCase();
  return (
    normalized === 'started' ||
    normalized === 'running' ||
    normalized === 'pending' ||
    normalized === 'partial' ||
    normalized === 'in_progress' ||
    normalized === 'queued' ||
    normalized === 'processing' ||
    normalized === 'streaming' ||
    normalized === 'active'
  );
}

function buildSessionStatusWarnings(session: LegacyOpencodeSessionRecord): string[] {
  return isUnsafeResumableLegacyStatus(session.legacyRawStatus)
    ? [`legacy_session_status_preserved_as_interrupted:${session.legacyRawStatus}`]
    : [];
}

function buildMessageScanWarnings(scan: LegacyOpencodeMessageScan): string[] {
  return [
    ...(scan.parseErrorCount > 0 ? [`legacy_message_parse_loss:${scan.parseErrorCount}`] : []),
    ...(scan.duplicateMsgIdCount > 0
      ? [`legacy_source_duplicate_msg_id:${scan.duplicateMsgIdCount}`]
      : []),
    ...(scan.missingMsgIdCount > 0
      ? [`legacy_source_missing_msg_id:${scan.missingMsgIdCount}`]
      : []),
  ];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function readSourceSchemaFingerprint(manifest: LegacyOpencodeSourceManifest): string | undefined {
  return manifest.legacyDaemonSchema?.fingerprint;
}

function backfillAutoDisplayName(
  existingDisplayName: string,
  legacyDisplayName: string | undefined,
  agentName: string,
): string {
  if (legacyDisplayName && (!existingDisplayName || existingDisplayName === agentName)) {
    return legacyDisplayName;
  }
  return existingDisplayName || legacyDisplayName || agentName;
}

function backfillAutoDescription(
  existingDescription: string | undefined,
  legacyDescription: string | undefined,
): string | undefined {
  if (
    legacyDescription &&
    (!existingDescription || AUTO_LEGACY_AGENT_DESCRIPTIONS.has(existingDescription))
  ) {
    return legacyDescription;
  }
  return existingDescription;
}

function backfillAutoDefaultWorkspaceDir(
  existingWorkspaceDir: string | undefined,
  legacyWorkspaceDir: string | undefined,
  sessionWorkspaceDir: string | undefined,
  defaultWorkspaceDir: string,
): string | undefined {
  const generatedWorkspaceDir =
    !existingWorkspaceDir ||
    existingWorkspaceDir === sessionWorkspaceDir ||
    existingWorkspaceDir === defaultWorkspaceDir;
  if (legacyWorkspaceDir && generatedWorkspaceDir) return legacyWorkspaceDir;
  return existingWorkspaceDir || legacyWorkspaceDir || sessionWorkspaceDir || defaultWorkspaceDir;
}

function mergeWarnings(
  existing: string[] | undefined,
  ...nextGroups: Array<string[] | undefined>
): string[] | undefined {
  const merged = [...(existing ?? []), ...nextGroups.flatMap((group) => group ?? [])].filter(
    Boolean,
  );
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}

/**
 * Merge the prior migration report with the report produced by the latest
 * `migrateMessages` round. Each round only re-computes the section(s) it just
 * imported (display / pi-history), so without merging the persisted `report`
 * would alternate between display-only and pi-history-only snapshots and lose
 * cumulative state. Pass `preservePriorDisplay` when this round skipped
 * display import and `preservePriorPiHistory` when this round skipped
 * pi-history import; the corresponding section is then copied from the prior
 * report so the persisted view reflects everything imported so far.
 */
function mergeMigrationReport(
  prior: unknown,
  next: unknown,
  options: { preservePriorDisplay: boolean; preservePriorPiHistory: boolean },
): unknown {
  if (!isPlainObject(next)) return next ?? prior;
  if (!isPlainObject(prior)) return next;
  const merged: Record<string, unknown> = { ...next };
  if (options.preservePriorDisplay && prior.display !== undefined) {
    merged.display = prior.display;
  }
  if (options.preservePriorPiHistory && prior.piHistory !== undefined) {
    merged.piHistory = prior.piHistory;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
