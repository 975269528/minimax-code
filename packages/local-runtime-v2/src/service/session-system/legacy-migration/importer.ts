import { isDeepStrictEqual } from 'node:util';

import type {
  CanonicalHistoryMessage,
  CanonicalHistoryPort,
} from '../messages/history/history-store.js';
import type { MessageRepository } from '../messages/repo/contract.js';
import {
  deriveLegacyDefaultProjectSessionIds,
  isDefaultProjectWorkspace,
} from '../shared/project-workspace.js';
import type { SessionRecord, SessionRepository, SessionStatus } from '../sessions/repo/contract.js';
import { deriveLegacySessionKind } from '../sessions/repo/drizzle/normalization.js';
import {
  buildLegacyContextBoundary,
  hasFalseReadyDisplayRecord,
  isDisplayReady,
  legacyContextBoundaryPreservation,
  LEGACY_CONTEXT_BOUNDARY_FINALIZATION_ERROR,
  LEGACY_CONTEXT_BOUNDARY_STRATEGY,
  LEGACY_CONTEXT_BOUNDARY_WARNING,
  type CanonicalRecoveryInput,
  type LegacyCanonicalRecoveryEvent,
} from './canonical-recovery.js';
import {
  recoverLegacyCanonicalSession,
  type CanonicalRecoveryPreservation,
} from './canonical-recovery-runner.js';
import {
  convertNativeMessagesToPiHistory,
  filterCompactedNativeMessages,
  type LegacyPiHistoryMessage,
  NATIVE_PI_HISTORY_CONVERTER_VERSION,
} from './conversion/native-conversion.js';
import { sanitizePiHistoryForMessages } from './conversion/pi-history-sanitizer.js';
import { checksumJson, importLegacyDisplayStream } from './display-import.js';
import {
  legacyHistoryTimestampCompatReport,
  legacyHistoryTimestampFailureMetadata,
  shouldRetryLegacyHistoryTimestampFailure,
} from './legacy-history-timestamp.js';
import {
  buildPiSeedHistory,
  DEFAULT_PI_SEED_STRATEGY,
  PI_SEED_MARKER_PREFIX,
  type LegacyPiSeedStrategyOptions,
} from './pi-seed.js';
import type { LegacyImportedAssetPort } from './assets.js';
import type {
  LegacyMigrationRecord,
  LegacyOpencodeMessageScan,
  LegacyOpencodeSessionRecord,
  LegacyOpencodeSourceReader,
  LegacyOpencodeSourceManifest,
  LegacySessionMigrationRepository,
} from './repo/contract.js';
import { detectPostPiCompactionReplacement } from './v3-upgrade.js';

type SessionImporterStore = Pick<SessionRepository, 'get' | 'list' | 'upsertImportedLegacy'>;

export interface LegacyOpencodeImporterOptions {
  readonly source: LegacyOpencodeSourceReader;
  readonly migrations: LegacySessionMigrationRepository;
  readonly sessions: SessionImporterStore;
  readonly messages: Pick<MessageRepository, 'list' | 'replaceStream'>;
  readonly history: Pick<CanonicalHistoryPort, 'getPiHistory' | 'replacePiHistory'>;
  readonly assets: LegacyImportedAssetPort;
  readonly sourceDeletion?: {
    deleteSessionMessages(identity: {
      readonly legacyDaemonSessionId: string;
      readonly legacyFrameworkSessionId?: string;
    }): void | Promise<void>;
    onError?(error: unknown, sessionId: string): void;
  };
  readonly defaultWorkspaceDir: () => string;
  /** Current primary alias used to discover legacy `main` rows, never to rewrite their identity. */
  readonly primaryAgentName?: string;
  readonly piSeedStrategy?: Partial<LegacyPiSeedStrategyOptions>;
  readonly nowMs?: () => number;
  readonly onPinnedSessionImported?: (sessionId: string) => Promise<void>;
  readonly onCanonicalRecovery?: (event: LegacyCanonicalRecoveryEvent) => void;
}

export class LegacyOpencodeMigrationError extends Error {
  constructor(
    readonly record: LegacyMigrationRecord,
    override readonly cause: unknown,
  ) {
    super(`Legacy OpenCode Session migration failed: ${errorMessage(cause)}`);
    this.name = 'LegacyOpencodeMigrationError';
  }
}

class LegacyContextBoundaryFinalizationError extends Error {
  constructor(override readonly cause: unknown) {
    super(LEGACY_CONTEXT_BOUNDARY_FINALIZATION_ERROR);
    this.name = 'LegacyContextBoundaryFinalizationError';
  }
}

/**
 * One-way, v2-owned lazy importer. It is the only path allowed to turn an
 * `opencode` Session into an executable `pi-agent` Session.
 */
export class LegacyOpencodeImporter {
  private readonly nowMs: () => number;
  private readonly piSeedStrategy: LegacyPiSeedStrategyOptions;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly discoveries = new Map<string, Promise<void>>();

  constructor(private readonly options: LegacyOpencodeImporterOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.piSeedStrategy = { ...DEFAULT_PI_SEED_STRATEGY, ...options.piSeedStrategy };
  }

  async ensureDisplayReady(sessionId: string): Promise<void> {
    await this.serialized(sessionId, async () => {
      await this.importSession(sessionId, { display: true, history: false });
    });
  }

  async ensureExecutionReady(sessionId: string): Promise<SessionRecord | undefined> {
    return this.serialized(sessionId, () =>
      this.importSession(sessionId, { display: true, history: true }),
    );
  }

  async ensureMetadataReady(sessionId: string): Promise<SessionRecord | undefined> {
    return this.serialized(sessionId, async () => {
      const existing = await this.options.sessions.get(sessionId);
      const previous = await this.options.migrations.getByLocalSessionId(sessionId);
      if (previous?.status === 'deleted') return undefined;
      if (existing && !previous) return existing;
      const source = await this.options.source.getSession(previous?.legacySessionId ?? sessionId);
      return source ? this.materializeMetadata(source) : existing;
    });
  }

  async markDeleted(sessionId: string): Promise<void> {
    await this.serialized(sessionId, async () => {
      const migration =
        (await this.options.migrations.getByLocalSessionId(sessionId)) ??
        (await this.options.migrations.getByLegacySessionId(sessionId));
      // The durable tombstone prevents rediscovery even when the obsolete source must stay.
      await this.options.migrations.markDeleted(sessionId);
      if (migration && this.options.sourceDeletion) {
        try {
          await this.options.sourceDeletion.deleteSessionMessages({
            legacyDaemonSessionId: migration.legacyDaemonSessionId ?? migration.legacySessionId,
            ...(migration.legacyFrameworkSessionId
              ? { legacyFrameworkSessionId: migration.legacyFrameworkSessionId }
              : {}),
          });
        } catch (error) {
          this.options.sourceDeletion.onError?.(error, sessionId);
        }
      }
    });
  }

  async discover(agentName?: string): Promise<void> {
    const scope = agentName ?? '*';
    const existing = this.discoveries.get(scope);
    if (existing) return existing;
    if (this.discoveries.has('*')) return this.discoveries.get('*');

    const current = this.runDiscovery(agentName);
    const scopes = this.discoveryScopes(agentName);
    scopes.forEach((discoveryScope) => this.discoveries.set(discoveryScope, current));
    try {
      await current;
    } catch (error) {
      scopes.forEach((discoveryScope) => {
        if (this.discoveries.get(discoveryScope) === current) {
          this.discoveries.delete(discoveryScope);
        }
      });
      throw error;
    }
  }

  private discoveryScopes(agentName?: string): string[] {
    const scope = agentName ?? '*';
    return agentName === this.options.primaryAgentName && agentName !== 'main'
      ? [scope, 'main']
      : [scope];
  }

  private async runDiscovery(agentName?: string): Promise<void> {
    const candidates = agentName
      ? await this.listLegacySessionsForAgent(agentName)
      : await this.options.source.listSessions();
    const legacyDefaultProjectSessionIds = await this.legacyDefaultProjectSessionIds(candidates);
    await Promise.all(
      candidates.map((session) =>
        this.serialized(session.sessionId, () =>
          this.materializeMetadata(session, legacyDefaultProjectSessionIds),
        ),
      ),
    );
  }

  async adopt(agentName: string): Promise<SessionRecord | undefined> {
    const candidates = await this.listLegacySessionsForAgent(agentName);
    const root = candidates
      .filter((session) => session.sessionType === 'root')
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
    if (!root) return undefined;
    const legacyDefaultProjectSessionIds = await this.legacyDefaultProjectSessionIds(candidates);
    return this.serialized(root.sessionId, () =>
      this.materializeMetadata(root, legacyDefaultProjectSessionIds),
    );
  }

  private async importSession(
    sessionId: string,
    scope: ImportScope,
  ): Promise<SessionRecord | undefined> {
    const existing = await this.options.sessions.get(sessionId);
    const previous = await this.options.migrations.getByLocalSessionId(sessionId);
    const repairDisplay = shouldRepairFalseReadyDisplay(existing, previous, scope);
    const failedRecordRecovery = await this.recoverCanonicalSession({
      sessionId,
      existing,
      previous,
      trigger: 'failed_record',
    });
    if (failedRecordRecovery) return failedRecordRecovery;
    const timestampCompatRetry = shouldRetryLegacyHistoryTimestampFailure(previous, scope.history);
    const ready = reusableImportResult(existing, previous, scope, timestampCompatRetry);
    if (ready.resolved && !repairDisplay) return ready.session;
    const legacySessionId = previous?.legacySessionId ?? sessionId;
    const sourceSession = await this.options.source.getSession(legacySessionId);
    if (!sourceSession) {
      if (timestampCompatRetry) {
        throw await this.failMigration(sessionId, previous, new Error('legacy source not found'), {
          timestampCompatRetry: true,
        });
      }
      return this.resolveMissingSourceWithRecovery({
        sessionId,
        existing,
        previous,
        repairDisplay,
        reusable: ready.resolved,
      });
    }
    try {
      return await this.runImport({
        sessionId,
        source: sourceSession,
        existing,
        previous,
        scope: repairDisplay ? { ...scope, repairDisplay: true } : scope,
        timestampCompatRetry,
      });
    } catch (error) {
      if (error instanceof LegacyOpencodeMigrationError) throw error;
      throw await this.failMigration(sessionId, previous, error, {
        source: sourceSession,
        timestampCompatRetry,
      });
    }
  }

  private async resolveMissingSourceWithRecovery(input: {
    readonly sessionId: string;
    readonly existing: SessionRecord | undefined;
    readonly previous: LegacyMigrationRecord | undefined;
    readonly repairDisplay: boolean;
    readonly reusable: boolean;
  }): Promise<SessionRecord | undefined> {
    const recovered = await this.recoverCanonicalSession({
      sessionId: input.sessionId,
      existing: input.existing,
      previous: input.previous,
      trigger: 'source_missing',
    });
    if (recovered) return recovered;
    if (input.repairDisplay && input.reusable) return input.existing;
    return this.resolveMissingSource(input.sessionId, input.existing, input.previous);
  }

  private async resolveMissingSource(
    sessionId: string,
    existing: SessionRecord | undefined,
    previous: LegacyMigrationRecord | undefined,
  ): Promise<SessionRecord | undefined> {
    if (!existing && !previous) return undefined;
    if (existing?.runtime !== 'opencode' && !previous) return existing;
    throw await this.failMigration(sessionId, previous, new Error('legacy source not found'));
  }

  private async recoverCanonicalSession(
    input: CanonicalRecoveryInput,
  ): Promise<SessionRecord | undefined> {
    return recoverLegacyCanonicalSession(input, {
      migrations: this.options.migrations,
      history: this.options.history,
      nowMs: this.nowMs,
      selectPreservation: canonicalRecoveryPreservation,
      onCanonicalRecovery: this.options.onCanonicalRecovery,
    });
  }

  private async runImport(input: ImportOperation): Promise<SessionRecord> {
    const session = await this.materializeSession(
      input.source,
      input.existing,
      input.previous === undefined,
    );
    const scan = await this.options.source.scanMessages(input.source.sessionId);
    const manifest = await this.options.source.getSourceManifest();
    const current =
      input.previous ?? (await this.options.migrations.getByLocalSessionId(input.sessionId));
    const results = await this.importRequested({
      sessionId: session.sessionId,
      source: input.source,
      scan,
      current,
      scope: input.scope,
      timestampCompatRetry: input.timestampCompatRetry,
    });
    const nowMs = this.nowMs();
    const record = buildMigrationRecord({
      source: input.source,
      session,
      scan,
      manifest,
      current,
      results,
      nowMs,
      timestampCompatRetry: input.timestampCompatRetry,
    });
    try {
      await this.options.migrations.upsert(record);
    } catch (error) {
      if (results.history?.strategy === LEGACY_CONTEXT_BOUNDARY_STRATEGY) {
        throw new LegacyContextBoundaryFinalizationError(error);
      }
      throw error;
    }
    return session;
  }

  private async importRequested(input: ImportRequest): Promise<ImportResults> {
    const display =
      input.scope.display && (input.scope.repairDisplay || !isDisplayReady(input.current))
        ? await this.importDisplay(input.sessionId, input.source, input.scan)
        : undefined;
    const history =
      input.scope.history && (input.timestampCompatRetry || !isHistoryReady(input.current))
        ? await this.importHistory(input.sessionId, input.source, input.scan, input.current)
        : undefined;
    return { display, history };
  }

  private async materializeMetadata(
    source: LegacyOpencodeSessionRecord,
    legacyDefaultProjectSessionIds?: ReadonlySet<string>,
  ): Promise<SessionRecord | undefined> {
    const previous = await this.options.migrations.getByLegacySessionId(source.sessionId);
    if (previous?.status === 'deleted') return undefined;
    const session = await this.materializeSession(
      source,
      await this.options.sessions.get(source.sessionId),
      previous === undefined,
      legacyDefaultProjectSessionIds,
    );
    if (!previous) {
      await this.options.migrations.upsert({
        legacySessionId: source.sessionId,
        localSessionId: session.sessionId,
        legacyDaemonSessionId: source.sessionId,
        legacyFrameworkSessionId: source.legacyFrameworkSessionId,
        sourceRuntime: 'opencode',
        status: 'metadata',
        migratedAtMs: this.nowMs(),
        sourceUpdatedAtMs: source.updatedAtMs,
        sourceFingerprint: checksumJson(sourceFingerprint(source)),
        warnings: sessionStatusWarnings(source),
      });
    }
    return session;
  }

  private async materializeSession(
    source: LegacyOpencodeSessionRecord,
    existing: SessionRecord | undefined,
    importLegacyPin: boolean,
    derivedLegacyDefaultProjectSessionIds?: ReadonlySet<string>,
  ): Promise<SessionRecord> {
    const parentSessionId = importedParentSessionId(existing, source);
    const sessionKind = deriveLegacySessionKind({
      purpose: existing?.purpose ?? source.purpose,
      sessionType: existing?.sessionType ?? source.sessionType,
      parentSessionId,
    });
    const parent = parentSessionId ? await this.options.sessions.get(parentSessionId) : undefined;
    const legacyDefaultProjectSessionIds =
      derivedLegacyDefaultProjectSessionIds ??
      (await this.legacyDefaultProjectSessionIds([source]));
    const session: SessionRecord = {
      ...existing,
      sessionId: source.sessionId,
      runtime: 'pi-agent',
      sessionKind,
      parentSessionId,
      ...importedIdentity(
        source,
        existing,
        this.options.defaultWorkspaceDir,
        legacyDefaultProjectSessionIds.has(source.sessionId),
      ),
      ...importedMetadata(source, existing, parent, sessionKind),
      status: normalizeLegacyStatus(source.status, source.legacyRawStatus),
      sessionOrigin: 'legacy-opencode',
      ...importedTimestamps(source, existing),
    };
    if (!existing || !sameSessionRecord(existing, session)) {
      await this.options.sessions.upsertImportedLegacy(session);
    }
    if (importLegacyPin && source.pinned) {
      await this.options.onPinnedSessionImported?.(session.sessionId);
    }
    return session;
  }

  private async legacyDefaultProjectSessionIds(
    sources: readonly LegacyOpencodeSessionRecord[],
  ): Promise<ReadonlySet<string>> {
    return deriveLegacyDefaultProjectSessionIds({
      sources,
      existing: await this.options.sessions.list({
        includeHidden: true,
        requireWorkspaceDir: true,
      }),
      defaultWorkspaceDir: this.options.defaultWorkspaceDir(),
    });
  }

  private async importDisplay(
    targetSessionId: string,
    sourceSession: LegacyOpencodeSessionRecord,
    scan: LegacyOpencodeMessageScan,
  ): Promise<DisplayImportResult> {
    const imported = await importLegacyDisplayStream({
      sourceSessionId: sourceSession.sessionId,
      targetSessionId,
      duplicateSourceMsgIds: scan.duplicateSourceMsgIds,
      source: this.options.source,
      messages: this.options.messages,
      assets: this.options.assets,
      nowMs: this.nowMs,
    });
    return {
      count: imported.count,
      checksum: imported.checksum,
      warnings: [
        ...imported.warnings,
        ...(imported.attachments.missing > 0
          ? [`legacy_attachment_missing_or_unreadable:${String(imported.attachments.missing)}`]
          : []),
      ],
      report: {
        sourceSessionIdVersion: LEGACY_DISPLAY_SOURCE_SESSION_ID_VERSION,
        sourceCount: scan.sourceCount,
        parsedCount: imported.parsedCount,
        importedCount: imported.count,
        duplicateMsgIdsRewritten: imported.duplicateRewritten,
        missingMsgIdsAssigned: imported.missingAssigned,
        attachments: imported.attachments,
      },
    };
  }

  private async importHistory(
    targetSessionId: string,
    sourceSession: LegacyOpencodeSessionRecord,
    scan: LegacyOpencodeMessageScan,
    previous: LegacyMigrationRecord | undefined,
  ): Promise<HistoryImportResult> {
    const existing = await this.options.history.getPiHistory(targetSessionId);
    if (hasSeedMarker(existing, sourceSession.sessionId)) {
      return { ready: true, strategy: 'existing-seed-preserved', warnings: [] };
    }
    const preserved = preservedCompactedHistory(existing, previous);
    if (preserved) return preserved;
    const native = await this.buildNativeHistory(sourceSession);
    if (native) return this.persistNativeHistory(targetSessionId, native, existing, previous);
    if (hasStaleNativeRows(existing, previous)) {
      return this.persistContextBoundary(targetSessionId, previous);
    }
    const sourceMessages = await this.options.source.listMessages(sourceSession.sessionId);
    const seed = await buildPiSeedHistory({
      session: sourceSession,
      messages: sourceMessages,
      sourceMessageScan: scan,
      options: this.piSeedStrategy,
      assets: this.options.assets,
      nowMs: this.nowMs,
    });
    const history = [...existing, ...toCanonicalHistory(seed.messages, this.nowMs)];
    await this.options.history.replacePiHistory(targetSessionId, history);
    return {
      ready: true,
      strategy: `display-seed-${seed.strategy}`,
      warnings: ['legacy_native_missing_or_unreadable', ...seed.warnings],
      report: seed.report,
    };
  }

  private async persistContextBoundary(
    sessionId: string,
    previous: LegacyMigrationRecord | undefined,
  ): Promise<HistoryImportResult> {
    const timestamp = Math.max(this.nowMs(), (previous?.migratedAtMs ?? 0) + 1);
    const boundary = buildLegacyContextBoundary(timestamp);
    await this.options.history.replacePiHistory(sessionId, [boundary], {
      snapshotId: LEGACY_CONTEXT_BOUNDARY_STRATEGY,
    });
    return {
      ready: true,
      strategy: LEGACY_CONTEXT_BOUNDARY_STRATEGY,
      warnings: [LEGACY_CONTEXT_BOUNDARY_WARNING],
      report: {
        canonicalRecovery: {
          version: LEGACY_CONTEXT_BOUNDARY_STRATEGY,
          recoveredAtMs: this.nowMs(),
          trigger: 'native_source_unavailable',
          displayReady: true,
          historyReady: true,
          result: 'degraded',
          contextBoundary: true,
        },
      },
    };
  }

  private async persistNativeHistory(
    sessionId: string,
    native: NativeHistoryImport,
    existing: readonly CanonicalHistoryMessage[],
    previous: LegacyMigrationRecord | undefined,
  ): Promise<HistoryImportResult> {
    const continuation = historyContinuation(existing, previous);
    const history = [
      ...toCanonicalHistory(native.messages, this.nowMs),
      ...sortHistoryGroups(continuation),
    ];
    await this.options.history.replacePiHistory(sessionId, history);
    return {
      ready: true,
      strategy: native.strategy,
      converterVersion: NATIVE_PI_HISTORY_CONVERTER_VERSION,
      warnings: mergeNativeWarnings(native.warnings, continuation.length),
      report: native.report,
    };
  }

  private async buildNativeHistory(
    sourceSession: LegacyOpencodeSessionRecord,
  ): Promise<NativeHistoryImport | undefined> {
    const native = await this.options.source.listNativeMessages(sourceSession);
    if (!native) return undefined;
    const filtered = filterCompactedNativeMessages(native.messages);
    const converted = convertNativeMessagesToPiHistory(filtered.messages, this.nowMs);
    const convertedMessages = converted.groups.flatMap(({ messages }) => messages);
    if (convertedMessages.length === 0) return undefined;
    if (converted.counts.source.toolCall > 0 && converted.counts.converted.toolCall === 0) {
      return undefined;
    }
    const sanitized = sanitizePiHistoryForMessages(convertedMessages, {
      tag: `migration:${sourceSession.sessionId}`,
    });
    if (sanitized.messages.length === 0) return undefined;
    return {
      messages: sanitized.messages,
      strategy: converted.degraded ? 'native-degraded' : 'native-full',
      warnings: [
        ...native.warnings,
        ...filtered.warnings,
        ...converted.warnings,
        ...sanitized.warnings,
      ],
      report: {
        source: {
          kind: native.source.kind,
          schemaFingerprint: native.source.schemaFingerprint,
          nativeSessionId: native.nativeSessionId,
        },
        nativeMessages: native.messages.length,
        filteredMessages: filtered.messages.length,
        importedMessages: sanitized.messages.length,
        losses: converted.losses,
        counts: converted.counts,
        sanitizer: sanitized.stats,
      },
    };
  }

  private async failMigration(
    sessionId: string,
    previous: LegacyMigrationRecord | undefined,
    error: unknown,
    options: MigrationFailureOptions = {},
  ): Promise<LegacyOpencodeMigrationError> {
    const now = this.nowMs();
    const timestampFailureMetadata = legacyHistoryTimestampFailureMetadata(
      error,
      options.timestampCompatRetry ?? false,
    );
    const record: LegacyMigrationRecord = {
      ...previous,
      legacySessionId: options.source?.sessionId ?? previous?.legacySessionId ?? sessionId,
      localSessionId: previous?.localSessionId ?? sessionId,
      legacyDaemonSessionId:
        options.source?.sessionId ?? previous?.legacyDaemonSessionId ?? sessionId,
      legacyFrameworkSessionId:
        options.source?.legacyFrameworkSessionId ?? previous?.legacyFrameworkSessionId,
      sourceRuntime: 'opencode',
      status: 'failed',
      migratedAtMs: now,
      sourceUpdatedAtMs: options.source?.updatedAtMs ?? previous?.sourceUpdatedAtMs,
      ...(options.timestampCompatRetry
        ? {
            report: legacyHistoryTimestampCompatReport(previous?.report, now, 'failed'),
          }
        : {}),
      error: { message: errorMessage(error), ...timestampFailureMetadata },
    };
    await this.options.migrations.upsert(record);
    return new LegacyOpencodeMigrationError(record, error);
  }

  private async listLegacySessionsForAgent(agentName: string) {
    const direct = await this.options.source.listSessions(agentName);
    if (agentName !== this.options.primaryAgentName || agentName === 'main') return direct;
    const aliased = await this.options.source.listSessions('main');
    const byId = new Map(direct.map((session) => [session.sessionId, session]));
    aliased.forEach((session) => byId.set(session.sessionId, session));
    return [...byId.values()];
  }

  private async serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.operations.get(sessionId) ?? Promise.resolve();
    const current = runAfter(predecessor, operation);
    this.operations.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(sessionId) === current) this.operations.delete(sessionId);
    }
  }
}

function sameSessionRecord(left: SessionRecord, right: SessionRecord): boolean {
  return isDeepStrictEqual(definedSessionFields(left), definedSessionFields(right));
}

function definedSessionFields(record: SessionRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

interface DisplayImportResult {
  count: number;
  checksum: string;
  warnings: string[];
  report: Record<string, unknown>;
}

interface HistoryImportResult {
  ready: boolean;
  strategy: string;
  converterVersion?: number;
  warnings: string[];
  report?: Record<string, unknown>;
}

interface ImportResults {
  readonly display?: DisplayImportResult;
  readonly history?: HistoryImportResult;
}

interface ImportScope {
  readonly display: boolean;
  readonly history: boolean;
  readonly repairDisplay?: boolean;
}

interface ImportOperation {
  readonly sessionId: string;
  readonly source: LegacyOpencodeSessionRecord;
  readonly existing: SessionRecord | undefined;
  readonly previous: LegacyMigrationRecord | undefined;
  readonly scope: ImportScope;
  readonly timestampCompatRetry: boolean;
}

interface MigrationFailureOptions {
  readonly source?: LegacyOpencodeSessionRecord;
  readonly timestampCompatRetry?: boolean;
}

interface FailedImportResultOptions {
  readonly session: SessionRecord | undefined;
  readonly record: LegacyMigrationRecord;
  readonly scope: ImportScope;
  readonly ready: boolean;
  readonly retryFailedTimestamp: boolean;
}

interface ImportRequest {
  readonly sessionId: string;
  readonly source: LegacyOpencodeSessionRecord;
  readonly scan: LegacyOpencodeMessageScan;
  readonly current: LegacyMigrationRecord | undefined;
  readonly scope: ImportScope;
  readonly timestampCompatRetry: boolean;
}

interface NativeHistoryImport {
  readonly messages: LegacyPiHistoryMessage[];
  readonly strategy: 'native-full' | 'native-degraded';
  readonly warnings: string[];
  readonly report: Record<string, unknown>;
}

function reusableImportResult(
  session: SessionRecord | undefined,
  record: LegacyMigrationRecord | undefined,
  scope: ImportScope,
  retryFailedTimestamp: boolean,
): { resolved: boolean; session: SessionRecord | undefined } {
  if (record?.status === 'deleted') return { resolved: true, session };
  const ready = isReady(session, record, scope);
  if (record?.status === 'failed') {
    return reusableFailedImportResult({ session, record, scope, ready, retryFailedTimestamp });
  }
  if (ready) return { resolved: true, session };
  const localPiSession = session?.runtime === 'pi-agent';
  const ownedByLegacy = session?.sessionOrigin === 'legacy-opencode';
  if (localPiSession && !ownedByLegacy && !record) return { resolved: true, session };
  return { resolved: false, session };
}

function reusableFailedImportResult(input: FailedImportResultOptions): {
  resolved: boolean;
  session: SessionRecord | undefined;
} {
  if (input.retryFailedTimestamp) return { resolved: false, session: input.session };
  if (canReuseFailedDisplay(input.ready, input.scope)) {
    return { resolved: true, session: input.session };
  }
  throw new LegacyOpencodeMigrationError(input.record, input.record.error ?? 'previous failure');
}

function canReuseFailedDisplay(ready: boolean, scope: ImportScope): boolean {
  return ready && scope.display && !scope.history;
}

function shouldRepairFalseReadyDisplay(
  session: SessionRecord | undefined,
  record: LegacyMigrationRecord | undefined,
  scope: ImportScope,
): boolean {
  return Boolean(
    scope.display &&
    session?.runtime === 'pi-agent' &&
    session.sessionOrigin === 'legacy-opencode' &&
    record &&
    record.status !== 'deleted' &&
    record.status !== 'failed' &&
    hasFalseReadyDisplayRecord(record),
  );
}

function canonicalRecoveryPreservation(
  history: readonly CanonicalHistoryMessage[],
  record: LegacyMigrationRecord,
): CanonicalRecoveryPreservation {
  const boundary = legacyContextBoundaryPreservation(history);
  if (boundary) return { preserved: boundary };
  if (!needsConverterUpgrade(record)) return {};
  const preserved = preservedCompactedHistory(history, record);
  return preserved ? { preserved } : { reason: 'stale_native_history_not_preserved' };
}

function buildMigrationRecord(input: {
  readonly source: LegacyOpencodeSessionRecord;
  readonly session: SessionRecord;
  readonly scan: LegacyOpencodeMessageScan;
  readonly manifest: LegacyOpencodeSourceManifest;
  readonly current: LegacyMigrationRecord | undefined;
  readonly results: ImportResults;
  readonly nowMs: number;
  readonly timestampCompatRetry: boolean;
}): LegacyMigrationRecord {
  const readiness = migrationReadiness(input.current, input.results, input.nowMs);
  const report = mergeReport(
    input.current?.report,
    input.results.display?.report,
    input.results.history?.report,
  );
  return {
    ...migrationIdentity(input.source, input.session),
    ...migrationSourceAudit(input.source, input.scan, input.manifest, input.nowMs),
    ...migrationConversionAudit(input.current, input.results),
    ...readiness,
    status: readiness.piHistoryReadyAtMs ? 'migrated' : 'metadata',
    warnings: mergeWarnings(
      input.current?.warnings,
      input.results.display?.warnings,
      input.results.history?.warnings,
      sessionStatusWarnings(input.source),
      scanWarnings(input.scan),
    ),
    report: input.timestampCompatRetry
      ? legacyHistoryTimestampCompatReport(report, input.nowMs, 'migrated')
      : report,
  };
}

function migrationIdentity(
  source: LegacyOpencodeSessionRecord,
  session: SessionRecord,
): Pick<
  LegacyMigrationRecord,
  | 'legacySessionId'
  | 'localSessionId'
  | 'legacyDaemonSessionId'
  | 'legacyFrameworkSessionId'
  | 'sourceRuntime'
> {
  return {
    legacySessionId: source.sessionId,
    localSessionId: session.sessionId,
    legacyDaemonSessionId: source.sessionId,
    legacyFrameworkSessionId: source.legacyFrameworkSessionId,
    sourceRuntime: 'opencode',
  };
}

function migrationSourceAudit(
  source: LegacyOpencodeSessionRecord,
  scan: LegacyOpencodeMessageScan,
  manifest: LegacyOpencodeSourceManifest,
  nowMs: number,
): Pick<
  LegacyMigrationRecord,
  | 'migratedAtMs'
  | 'sourceUpdatedAtMs'
  | 'sourceFingerprint'
  | 'sourceSchemaFingerprint'
  | 'sourceChecksum'
  | 'sourceManifest'
  | 'sourceMessageCount'
> {
  return {
    migratedAtMs: nowMs,
    sourceUpdatedAtMs: source.updatedAtMs,
    sourceFingerprint: checksumJson(sourceFingerprint(source)),
    sourceSchemaFingerprint: manifest.legacyDaemonSchema?.fingerprint,
    sourceChecksum: scan.rawChecksum,
    sourceManifest: manifest,
    sourceMessageCount: scan.sourceCount,
  };
}

function migrationConversionAudit(
  current: LegacyMigrationRecord | undefined,
  results: ImportResults,
): Pick<
  LegacyMigrationRecord,
  'displayChecksum' | 'piHistoryStrategy' | 'piHistoryConverterVersion' | 'importedMessageCount'
> {
  return {
    displayChecksum: results.display?.checksum ?? current?.displayChecksum,
    piHistoryStrategy: results.history?.strategy ?? current?.piHistoryStrategy,
    piHistoryConverterVersion: results.history
      ? results.history.converterVersion
      : current?.piHistoryConverterVersion,
    importedMessageCount: results.display?.count ?? current?.importedMessageCount,
  };
}

function migrationReadiness(
  current: LegacyMigrationRecord | undefined,
  results: ImportResults,
  nowMs: number,
): Pick<
  LegacyMigrationRecord,
  'ledgerImportedAtMs' | 'projectionReadyAtMs' | 'displayReadyAtMs' | 'piHistoryReadyAtMs'
> {
  const displayReadyAtMs = results.display ? nowMs : current?.displayReadyAtMs;
  const piHistoryReadyAtMs = results.history?.ready ? nowMs : current?.piHistoryReadyAtMs;
  const anyReady = Boolean(displayReadyAtMs ?? piHistoryReadyAtMs);
  return {
    ledgerImportedAtMs: anyReady ? nowMs : current?.ledgerImportedAtMs,
    projectionReadyAtMs: displayReadyAtMs ?? current?.projectionReadyAtMs,
    displayReadyAtMs,
    piHistoryReadyAtMs,
  };
}

function isReady(
  session: SessionRecord | undefined,
  record: LegacyMigrationRecord | undefined,
  scope: ImportScope,
): boolean {
  return Boolean(
    session?.runtime === 'pi-agent' &&
    (!scope.display || isDisplayReady(record)) &&
    (!scope.history || isHistoryReady(record)),
  );
}

function isHistoryReady(record: LegacyMigrationRecord | undefined): boolean {
  if (!record?.piHistoryReadyAtMs) return false;
  if (!record.piHistoryStrategy?.startsWith('native-')) return true;
  return (record.piHistoryConverterVersion ?? 0) >= NATIVE_PI_HISTORY_CONVERTER_VERSION;
}

function needsConverterUpgrade(
  record: LegacyMigrationRecord | undefined,
): record is LegacyMigrationRecord {
  return Boolean(
    record?.piHistoryStrategy?.startsWith('native-') &&
    (record.piHistoryConverterVersion ?? 0) < NATIVE_PI_HISTORY_CONVERTER_VERSION,
  );
}

function shouldPreserveCompactedHistory(
  history: readonly CanonicalHistoryMessage[],
  record: LegacyMigrationRecord,
): boolean {
  if (history.length === 0) return false;
  const legacyRows = history.filter(
    (message) => (message.timestamp ?? Number.POSITIVE_INFINITY) <= record.migratedAtMs,
  ).length;
  return Boolean(detectPostPiCompactionReplacement(history, legacyRows));
}

function preservedCompactedHistory(
  history: readonly CanonicalHistoryMessage[],
  record: LegacyMigrationRecord | undefined,
): HistoryImportResult | undefined {
  if (!needsConverterUpgrade(record)) return undefined;
  if (!shouldPreserveCompactedHistory(history, record)) return undefined;
  return {
    ready: true,
    strategy: record.piHistoryStrategy ?? 'native-full',
    converterVersion: NATIVE_PI_HISTORY_CONVERTER_VERSION,
    warnings: [`legacy_v3_skipped_post_pi_compaction:${history.length}`],
  };
}

function hasStaleNativeRows(
  history: readonly CanonicalHistoryMessage[],
  record: LegacyMigrationRecord | undefined,
): boolean {
  if (!record?.piHistoryStrategy?.startsWith('native-')) return false;
  return history.some(
    (message) => (message.timestamp ?? Number.POSITIVE_INFINITY) <= record.migratedAtMs,
  );
}

function historyContinuation(
  history: readonly CanonicalHistoryMessage[],
  record: LegacyMigrationRecord | undefined,
): CanonicalHistoryMessage[] {
  if (!record) return [...history];
  return history.filter(
    (message) => (message.timestamp ?? Number.POSITIVE_INFINITY) > record.migratedAtMs,
  );
}

function mergeNativeWarnings(warnings: readonly string[], continuationCount: number): string[] {
  if (continuationCount === 0) return [...warnings];
  return [...warnings, `legacy_user_continuation_preserved:${continuationCount}`];
}

function importedParentSessionId(
  existing: SessionRecord | undefined,
  source: LegacyOpencodeSessionRecord,
): string | null {
  return existing?.parentSessionId ?? source.parentSessionId ?? null;
}

function importedIdentity(
  source: LegacyOpencodeSessionRecord,
  existing: SessionRecord | undefined,
  defaultWorkspaceDir: () => string,
  derivedDefaultWorkspace: boolean,
): Pick<SessionRecord, 'agentName' | 'workspaceDir' | 'isDefaultWorkspace' | 'sessionType'> {
  const workspaceDir = existing?.workspaceDir || source.workspaceDir || defaultWorkspaceDir();
  const isDefaultWorkspace = isDefaultProjectWorkspace({
    sessionId: source.sessionId,
    workspaceDir,
    explicitIsDefaultWorkspace: derivedDefaultWorkspace ? true : source.isDefaultWorkspace,
    runLocation: existing?.runLocation,
    defaultWorkspaceDir: defaultWorkspaceDir(),
  });
  return {
    agentName: importedAgentName(source.agentName, existing?.agentName),
    workspaceDir,
    isDefaultWorkspace,
    sessionType: existing?.sessionType ?? source.sessionType,
  };
}

function importedAgentName(sourceAgentName: string, existingAgentName: string | undefined): string {
  if (sourceAgentName === 'main') return sourceAgentName;
  return existingAgentName ?? sourceAgentName;
}

function importedMetadata(
  source: LegacyOpencodeSessionRecord,
  existing: SessionRecord | undefined,
  parent: SessionRecord | undefined,
  sessionKind: SessionRecord['sessionKind'],
): Pick<SessionRecord, 'archived' | 'title' | 'visibility' | 'purpose'> {
  return {
    archived: existing?.archived ?? source.archived,
    title: existing?.title ?? source.title ?? null,
    visibility: importedVisibility(source, existing, parent, sessionKind),
    purpose: existing?.purpose ?? source.purpose,
  };
}

function importedVisibility(
  source: LegacyOpencodeSessionRecord,
  existing: SessionRecord | undefined,
  parent: SessionRecord | undefined,
  sessionKind: SessionRecord['sessionKind'],
): NonNullable<SessionRecord['visibility']> {
  if (parent?.visibility === 'hidden') return 'hidden';
  if (sessionKind === 'task') return 'visible';
  if (sessionKind === 'peek') return 'hidden';
  return existing?.visibility ?? source.visibility ?? 'visible';
}

function importedTimestamps(
  source: LegacyOpencodeSessionRecord,
  existing: SessionRecord | undefined,
): Pick<SessionRecord, 'createdAtMs' | 'updatedAtMs'> {
  return {
    createdAtMs: existing?.createdAtMs ?? source.createdAtMs,
    updatedAtMs: Math.max(existing?.updatedAtMs ?? 0, source.updatedAtMs),
  };
}

function normalizeLegacyStatus(
  status: LegacyOpencodeSessionRecord['status'],
  rawStatus?: string | null,
): SessionStatus {
  if (isUnsafeLegacyStatus(rawStatus ?? status)) return 'interrupted';
  if (status === 'finished') return 'idle';
  return status;
}

function isUnsafeLegacyStatus(status: string | null | undefined): boolean {
  return [
    'started',
    'running',
    'pending',
    'partial',
    'in_progress',
    'queued',
    'processing',
    'streaming',
    'active',
  ].includes(status?.trim().toLowerCase() ?? '');
}

function sessionStatusWarnings(session: LegacyOpencodeSessionRecord): string[] {
  return isUnsafeLegacyStatus(session.legacyRawStatus)
    ? [`legacy_session_status_preserved_as_interrupted:${session.legacyRawStatus}`]
    : [];
}

function scanWarnings(scan: LegacyOpencodeMessageScan): string[] {
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

function sourceFingerprint(session: LegacyOpencodeSessionRecord): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    legacyFrameworkSessionId: session.legacyFrameworkSessionId,
    updatedAtMs: session.updatedAtMs,
    status: session.status,
    legacyRawStatus: session.legacyRawStatus,
  };
}

function toCanonicalHistory(
  messages: readonly LegacyPiHistoryMessage[],
  nowMs: () => number,
): CanonicalHistoryMessage[] {
  return messages.flatMap((message, index) => {
    const record: Record<string, unknown> = { ...message };
    if (typeof record.role !== 'string') return [];
    return [
      {
        ...record,
        role: record.role,
        timestamp:
          typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
            ? record.timestamp
            : nowMs() + index,
      },
    ];
  });
}

function sortHistoryGroups(history: readonly CanonicalHistoryMessage[]): CanonicalHistoryMessage[] {
  const groups: Array<{ timestamp: number; messages: CanonicalHistoryMessage[] }> = [];
  history.forEach((message) => {
    if (message.role === 'toolResult' && groups.at(-1)?.messages[0]?.role === 'assistant') {
      groups.at(-1)?.messages.push(message);
      return;
    }
    groups.push({ timestamp: message.timestamp ?? Number.NEGATIVE_INFINITY, messages: [message] });
  });
  return groups
    .sort((left, right) => left.timestamp - right.timestamp)
    .flatMap(({ messages }) => messages);
}

function hasSeedMarker(history: readonly CanonicalHistoryMessage[], sessionId: string): boolean {
  const marker = `${PI_SEED_MARKER_PREFIX}${sessionId}`;
  return history.some((message) => JSON.stringify(message).includes(marker));
}

function mergeWarnings(...groups: Array<readonly string[] | undefined>): string[] | undefined {
  const warnings = [...new Set(groups.flatMap((group) => group ?? []).filter(Boolean))];
  return warnings.length > 0 ? warnings : undefined;
}

function mergeReport(
  previous: unknown,
  display: Record<string, unknown> | undefined,
  history: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const prior = isRecord(previous) ? previous : {};
  const merged = {
    ...prior,
    ...(display ? { display } : {}),
    ...(history ? { piHistory: history } : {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function runAfter<T>(predecessor: Promise<unknown>, operation: () => Promise<T>): Promise<T> {
  try {
    await predecessor;
  } catch {
    // A failed predecessor must not poison the next readiness attempt.
  }
  return operation();
}

const LEGACY_DISPLAY_SOURCE_SESSION_ID_VERSION = 1;
