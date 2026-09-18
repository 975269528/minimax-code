import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface LegacyOpencodeDisplayMessage extends Record<string, unknown> {
  readonly msg_id?: string;
  readonly parent_msg_id?: string;
  readonly timestamp?: number;
  readonly msg_content?: string;
  readonly msg_type?: number;
  readonly role?: string;
  readonly thinking_content?: string;
  readonly thinking_duration_ms?: number;
  readonly finish_reason?: string;
  readonly tool_calls?: readonly Record<string, unknown>[];
  readonly attachments?: readonly Record<string, unknown>[];
}
export type LegacyOpencodeSessionStatus =
  | 'idle'
  | 'started'
  | 'finished'
  | 'error'
  | 'aborted'
  | 'interrupted';
export type LegacyOpencodeSessionType = 'root' | 'branch';
export interface LegacyOpencodeSessionRecord {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  /** True when the reader synthesized the daemon's per-session fallback workspace. */
  readonly isDefaultWorkspace?: boolean;
  readonly runtime: 'opencode';
  readonly sessionType: LegacyOpencodeSessionType;
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: 'visible' | 'hidden';
  readonly purpose?: string;
  readonly status: LegacyOpencodeSessionStatus;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly legacyFrameworkSessionId?: string;
  readonly legacyRawStatus?: string | null;
}
export interface LegacyOpencodeAgentRecord {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly avatar?: string;
  readonly persona?: string;
  readonly systemPrompt?: string;
  readonly defaultWorkspaceDir?: string;
  readonly rootSessionId?: string;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}
export interface LegacyOpenCodeNativePart {
  readonly id?: string;
  readonly type: string;
  readonly text?: string;
  readonly data?: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly timestamp?: number;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly raw?: Readonly<Record<string, unknown>>;
}
export interface LegacyOpenCodeNativeMessage {
  readonly id: string;
  readonly role?: string;
  readonly timestamp?: number;
  readonly model?: string;
  readonly provider?: string;
  readonly api?: string;
  readonly parts: readonly LegacyOpenCodeNativePart[];
  readonly raw?: Readonly<Record<string, unknown>>;
}
export type LegacyOpenCodeCandidateKind =
  | 'sandbox-data'
  | 'sandbox-state'
  | 'xdg-data'
  | 'xdg-state';
export interface LegacyOpenCodeNativeCandidateInput {
  readonly kind: LegacyOpenCodeCandidateKind;
  readonly dbPath: string;
}
export interface LegacyOpencodeReadonlySourceOptions {
  readonly sourceDataDir: string;
  readonly nativeCandidates?: readonly LegacyOpenCodeNativeCandidateInput[];
}
export interface LegacyOpencodeTableSchema {
  readonly tables: ReadonlyMap<string, ReadonlySet<string>>;
}
export function resolveLegacyNativeCandidateInputs(
  options: LegacyOpencodeReadonlySourceOptions,
): readonly LegacyOpenCodeNativeCandidateInput[] {
  return (
    options.nativeCandidates ?? [
      {
        kind: 'sandbox-data',
        dbPath: join(options.sourceDataDir, 'opencode', 'data', 'opencode', 'opencode.db'),
      },
      {
        kind: 'sandbox-state',
        dbPath: join(options.sourceDataDir, 'opencode', 'state', 'opencode', 'opencode.db'),
      },
      {
        kind: 'xdg-data',
        dbPath: join(
          process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'),
          'opencode',
          'opencode.db',
        ),
      },
      {
        kind: 'xdg-state',
        dbPath: join(
          process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state'),
          'opencode',
          'opencode.db',
        ),
      },
    ]
  );
}
export interface LegacyOpenCodeNativeCandidate {
  readonly kind: LegacyOpenCodeCandidateKind;
  readonly path: string;
  readonly exists: boolean;
  readonly dbPath: string;
  readonly dbExists: boolean;
  readonly dbSizeBytes?: number;
  readonly schemaFingerprint?: string;
  readonly tables?: Readonly<Record<string, readonly string[]>>;
  readonly error?: string;
}
export interface LegacyOpenCodeNativeReadResult {
  readonly source: LegacyOpenCodeNativeCandidate;
  readonly nativeSessionId: string;
  readonly messages: readonly LegacyOpenCodeNativeMessage[];
  readonly warnings: readonly string[];
}
export interface LegacyDaemonSchemaManifest {
  readonly fingerprint: string;
  readonly logicVersion?: number;
  readonly tables: Readonly<Record<string, readonly string[]>>;
  readonly indexes: Readonly<Record<string, readonly string[]>>;
  readonly detectedShape: 'legacy-daemon' | 'partial-legacy-daemon' | 'unknown';
  readonly warnings?: readonly string[];
}
export interface LegacyOpencodeSourceManifest {
  readonly sourceDataDir: string;
  readonly sourceSqlitePath: string;
  readonly sourceSqliteExists: boolean;
  readonly sourceSqliteSizeBytes?: number;
  readonly sourceSqliteWalPath: string;
  readonly sourceSqliteWalExists: boolean;
  readonly sourceSqliteWalSizeBytes?: number;
  readonly sourceSqliteShmPath: string;
  readonly sourceSqliteShmExists: boolean;
  readonly sourceSqliteShmSizeBytes?: number;
  readonly sourceOpenCodeDataPath: string;
  readonly sourceOpenCodeDataExists: boolean;
  readonly sourceOpenCodeStatePath: string;
  readonly sourceOpenCodeStateExists: boolean;
  readonly sourceOpenCodeXdgDataPath: string;
  readonly sourceOpenCodeXdgDataExists: boolean;
  readonly sourceOpenCodeXdgStatePath: string;
  readonly sourceOpenCodeXdgStateExists: boolean;
  readonly opencodeNative: { readonly candidates: readonly LegacyOpenCodeNativeCandidate[] };
  readonly legacyDaemonSchema?: LegacyDaemonSchemaManifest;
  readonly tableCounts?: Readonly<Record<string, number>>;
  readonly errors?: readonly string[];
}
export interface LegacyOpencodeMessageScan {
  readonly sourceCount: number;
  readonly parseErrorCount: number;
  readonly missingMsgIdCount: number;
  readonly duplicateMsgIdCount: number;
  readonly duplicateSourceMsgIds: readonly string[];
  readonly rawChecksum: string;
  readonly parsedChecksum: string;
}
export interface LegacyOpencodeMessageListOptions {
  readonly limit?: number;
  readonly before?: string;
}
export interface LegacyOpencodeMessagePage {
  readonly messages: readonly LegacyOpencodeDisplayMessage[];
  readonly nextCursor?: string;
}
export type LegacyMigrationStatus = 'discovered' | 'metadata' | 'migrated' | 'failed' | 'deleted';
export interface LegacyMigrationRecord {
  readonly legacySessionId: string;
  readonly localSessionId: string;
  readonly legacyDaemonSessionId?: string;
  readonly legacyFrameworkSessionId?: string;
  readonly sourceRuntime: 'opencode';
  readonly status: LegacyMigrationStatus;
  readonly migratedAtMs: number;
  readonly sourceUpdatedAtMs?: number;
  readonly sourceFingerprint?: string;
  readonly sourceSchemaFingerprint?: string;
  readonly sourceChecksum?: string;
  readonly displayChecksum?: string;
  readonly piHistoryStrategy?: string;
  readonly piHistoryConverterVersion?: number;
  readonly sourceManifest?: unknown;
  readonly sourceMessageCount?: number;
  readonly importedMessageCount?: number;
  readonly report?: unknown;
  readonly ledgerImportedAtMs?: number;
  readonly projectionReadyAtMs?: number;
  readonly displayReadyAtMs?: number;
  readonly piHistoryReadyAtMs?: number;
  readonly warnings?: readonly string[];
  readonly error?: unknown;
}

export class LegacyOpencodeSourceCorruptionError extends Error {
  override readonly name = 'LegacyOpencodeSourceCorruptionError';
  constructor(readonly source: string) {
    super(`Legacy OpenCode source is corrupt: ${source}`);
  }
}

export function decodeLegacyDisplayMessage(raw: string): LegacyOpencodeDisplayMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Legacy OpenCode source is corrupt: display-message');
  }
  if (!record(value) || (value.msg_id !== undefined && typeof value.msg_id !== 'string')) {
    throw new Error('Legacy OpenCode source is corrupt: display-message');
  }
  return value;
}
export function buildLegacyMessagePage(
  messages: readonly LegacyOpencodeDisplayMessage[],
  input?: number | LegacyOpencodeMessageListOptions,
): LegacyOpencodeMessagePage {
  const options = typeof input === 'number' ? { limit: input } : (input ?? {});
  const before = options.before
    ? messages.findIndex(({ msg_id: messageId }) => messageId === options.before)
    : messages.length;
  const eligible = before < 0 ? messages : messages.slice(0, before);
  const validLimit =
    options.limit !== undefined && Number.isFinite(options.limit) && options.limit > 0;
  const limit = validLimit ? Math.min(1000, Math.floor(options.limit as number)) : eligible.length;
  const selected = eligible.slice(Math.max(0, eligible.length - limit));
  return {
    messages: selected,
    ...(eligible.length > selected.length && selected[0]?.msg_id
      ? { nextCursor: selected[0].msg_id }
      : {}),
  };
}
export function scanLegacyMessages(raw: readonly string[]): LegacyOpencodeMessageScan {
  return scanLegacyMessageValues(raw);
}
export function scanLegacyMessageValues(raw: Iterable<string>): LegacyOpencodeMessageScan {
  const rawHash = createHash('sha256');
  const parsedHash = createHash('sha256');
  parsedHash.update('[');
  const seenIds = new Set<string>();
  const duplicateSourceMsgIds = new Set<string>();
  let sourceCount = 0;
  let parsedCount = 0;
  let parseErrorCount = 0;
  let missingMsgIdCount = 0;
  let duplicateMsgIdCount = 0;
  for (const value of raw) {
    if (sourceCount > 0) rawHash.update('\n');
    rawHash.update(value);
    sourceCount += 1;
    try {
      const message = decodeLegacyDisplayMessage(value);
      if (parsedCount > 0) parsedHash.update(',');
      parsedHash.update(JSON.stringify(message));
      parsedCount += 1;
      const messageId = message.msg_id;
      if (!messageId) missingMsgIdCount += 1;
      else if (seenIds.has(messageId)) {
        duplicateMsgIdCount += 1;
        duplicateSourceMsgIds.add(messageId);
      } else seenIds.add(messageId);
    } catch {
      parseErrorCount += 1;
    }
  }
  parsedHash.update(']');
  return {
    sourceCount,
    parseErrorCount,
    missingMsgIdCount,
    duplicateMsgIdCount,
    duplicateSourceMsgIds: [...duplicateSourceMsgIds],
    rawChecksum: rawHash.digest('hex'),
    parsedChecksum: parsedHash.digest('hex'),
  };
}
export function emptyLegacyMessageScan(): LegacyOpencodeMessageScan {
  return {
    sourceCount: 0,
    parseErrorCount: 0,
    missingMsgIdCount: 0,
    duplicateMsgIdCount: 0,
    duplicateSourceMsgIds: [],
    rawChecksum: hash(''),
    parsedChecksum: hash('[]'),
  };
}
export function normalizeLegacySessionType(value: number): LegacyOpencodeSessionType {
  return value === 1 ? 'root' : 'branch';
}
export function normalizeLegacySessionStatus(
  value: string | undefined,
): LegacyOpencodeSessionStatus {
  const normalized = value?.trim().toLowerCase();
  if (matches(normalized, ['finished', 'error', 'aborted', 'interrupted'])) {
    return normalized as LegacyOpencodeSessionStatus;
  }
  if (matches(normalized, ['completed', 'complete', 'success', 'succeeded', 'done'])) {
    return 'finished';
  }
  if (matches(normalized, ['failed', 'failure'])) return 'error';
  if (matches(normalized, ['cancelled', 'canceled'])) return 'aborted';
  if (!normalized) return 'finished';
  if (
    [
      'started',
      'running',
      'pending',
      'partial',
      'in_progress',
      'queued',
      'processing',
      'streaming',
      'active',
    ].includes(normalized)
  )
    return 'started';
  return 'idle';
}
export function decodeLegacySessionRow(row: unknown): LegacyOpencodeSessionRecord {
  const rawStatus = fieldString(row, 'status');
  return {
    sessionId: requiredField(row, 'session_id'),
    agentName: requiredField(row, 'agent_name'),
    workspaceDir: fieldString(row, 'workspace_dir') ?? '',
    runtime: 'opencode',
    sessionType: normalizeLegacySessionType(requiredNumber(row, 'session_type')),
    archived: Boolean(fieldNumber(row, 'compressed') ?? fieldNumber(row, 'archived') ?? 0),
    pinned: Boolean(fieldNumber(row, 'pinned') ?? 0),
    ...(has(row, 'title') ? { title: nullableField(row, 'title') } : {}),
    ...(has(row, 'parent_session_id')
      ? { parentSessionId: nullableField(row, 'parent_session_id') }
      : {}),
    ...extraDataFields(fieldString(row, 'extra_data')),
    status: normalizeLegacySessionStatus(rawStatus),
    createdAtMs: requiredTimestampMs(row, 'created_at'),
    updatedAtMs: requiredTimestampMs(row, 'updated_at'),
    ...namedString('legacyFrameworkSessionId', row, 'framework_session_id'),
    ...(has(row, 'status') ? { legacyRawStatus: rawStatus ?? null } : {}),
  };
}
export function decodeLegacyAgentRow(row: unknown): LegacyOpencodeAgentRecord {
  const name = requiredField(row, 'agent_name');
  const displayName = legacyAgentDisplayName(row, name);
  return {
    name,
    displayName,
    ...namedString('description', row, 'description'),
    ...namedString('avatar', row, 'avatar'),
    ...namedString('persona', row, 'persona'),
    ...namedFirstString('systemPrompt', row, ['system_prompt', 'systemPrompt']),
    ...namedFirstString('defaultWorkspaceDir', row, ['default_workspace_dir', 'workspace_dir']),
    ...namedFirstString('rootSessionId', row, ['root_session_id', 'main_session_id']),
    ...namedTimestampMs('createdAtMs', row, 'created_at'),
    ...namedTimestampMs('updatedAtMs', row, 'updated_at'),
  };
}
function legacyAgentDisplayName(row: unknown, fallback: string) {
  if (has(row, 'display_name')) return requiredField(row, 'display_name');
  if (has(row, 'agent_display_name')) return requiredField(row, 'agent_display_name');
  return fallback;
}
function namedFirstString<Key extends string>(
  key: Key,
  value: unknown,
  sources: readonly string[],
) {
  const found = sources.map((source) => fieldString(value, source)).find(Boolean);
  return found ? ({ [key]: found } as Record<Key, string>) : {};
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function matches(value: string | undefined, choices: readonly string[]) {
  return choices.includes(value ?? '');
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function has(value: unknown, key: string): value is Record<string, unknown> {
  return record(value) && Object.hasOwn(value, key);
}
function fieldString(value: unknown, key: string) {
  return has(value, key) && typeof value[key] === 'string' ? value[key] : undefined;
}
function requiredField(value: unknown, key: string) {
  const found = fieldString(value, key);
  if (!found) corrupt(key);
  return found;
}
function fieldNumber(value: unknown, key: string) {
  const found = has(value, key) ? value[key] : undefined;
  if (typeof found === 'string' && found) return Number(found);
  return typeof found === 'number' ? found : undefined;
}
function requiredNumber(value: unknown, key: string) {
  const found = fieldNumber(value, key);
  if (found === undefined || !Number.isFinite(found)) corrupt(key);
  return Math.floor(found);
}
function fieldTimestampMs(value: unknown, key: string) {
  const found = has(value, key) ? value[key] : undefined;
  if (typeof found === 'number') return Number.isFinite(found) ? found : undefined;
  if (typeof found !== 'string') return undefined;
  const numeric = Number(found);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(found);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function requiredTimestampMs(value: unknown, key: string) {
  const found = fieldTimestampMs(value, key);
  if (found === undefined) corrupt(key);
  return Math.floor(found);
}
function nullableField(value: unknown, key: string) {
  if (!has(value, key) || value[key] === null) return null;
  if (typeof value[key] === 'string') return value[key];
  return corrupt(key);
}
function namedString<Key extends string>(key: Key, value: unknown, source: string) {
  const found = fieldString(value, source);
  return found ? ({ [key]: found } as Record<Key, string>) : {};
}
function namedTimestampMs<Key extends string>(key: Key, value: unknown, source: string) {
  const found = fieldTimestampMs(value, source);
  return found === undefined ? {} : ({ [key]: found } as Record<Key, number>);
}
function extraDataFields(raw: string | undefined) {
  if (!raw) return { visibility: 'visible' as const };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { visibility: 'visible' as const };
  }
  if (!record(value)) return { visibility: 'visible' as const };
  return {
    visibility: value.visibility === 'hidden' ? ('hidden' as const) : ('visible' as const),
    ...(typeof value.purpose === 'string' && value.purpose ? { purpose: value.purpose } : {}),
  };
}
function corrupt(source: string): never {
  throw new Error(`Legacy OpenCode source is corrupt: ${source}`);
}
