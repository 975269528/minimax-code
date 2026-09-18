import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  buildLegacyMessagePage,
  decodeLegacyAgentRow,
  decodeLegacyDisplayMessage,
  decodeLegacySessionRow,
  emptyLegacyMessageScan,
  LegacyOpencodeSourceCorruptionError,
  resolveLegacyNativeCandidateInputs,
  scanLegacyMessageValues,
  type LegacyDaemonSchemaManifest,
  type LegacyOpenCodeCandidateKind,
  type LegacyOpenCodeNativeCandidate,
  type LegacyOpenCodeNativeCandidateInput,
  type LegacyOpenCodeNativeMessage,
  type LegacyOpenCodeNativePart,
  type LegacyOpenCodeNativeReadResult,
  type LegacyOpencodeAgentRecord,
  type LegacyOpencodeDisplayMessage,
  type LegacyOpencodeMessageListOptions,
  type LegacyOpencodeMessagePage,
  type LegacyOpencodeMessageScan,
  type LegacyOpencodeReadonlySourceOptions,
  type LegacyOpencodeSessionRecord,
  type LegacyOpencodeSourceManifest,
  type LegacyOpencodeTableSchema,
} from './model.js';

interface Statement {
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  iterate(...values: unknown[]): IterableIterator<unknown>;
}
interface ReadonlyDatabase {
  prepare(sql: string): Statement;
  close(): void;
}
type DatabaseConstructor = new (
  path: string,
  options: { readonly: true; fileMustExist: true },
) => ReadonlyDatabase;
const DEFAULT_MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;
export function createLegacyOpencodeReadonlySource(
  options: LegacyOpencodeReadonlySourceOptions,
): SqliteLegacyOpencodeReadonlySource {
  return new SqliteLegacyOpencodeReadonlySource(options);
}

class SqliteLegacyOpencodeReadonlySource {
  private readonly daemonPath: string;
  constructor(private readonly options: LegacyOpencodeReadonlySourceOptions) {
    this.daemonPath = join(options.sourceDataDir, 'sqlite.db');
  }

  async getSession(sessionId: string) {
    return this.withDaemon((db) => {
      const schema = inspectSchema(db);
      if (!canReadSessions(schema)) return undefined;
      const rows = querySessions(db, schema);
      return rows
        .map((row) => this.decodeSession(row))
        .find(
          (session) =>
            session.sessionId === sessionId || session.legacyFrameworkSessionId === sessionId,
        );
    });
  }
  async listSessions(agentName?: string) {
    return (
      this.withDaemon((db) => {
        const schema = inspectSchema(db);
        if (!canReadSessions(schema)) return [];
        return querySessions(db, schema, agentName)
          .map((row) => this.decodeSession(row))
          .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
      }) ?? []
    );
  }
  async listMessages(sessionId: string, options?: number | LegacyOpencodeMessageListOptions) {
    return (await this.listMessagePage(sessionId, options)).messages;
  }
  async *streamMessagePages(
    sessionId: string,
    pageSize: number,
    maxPageBytes: number = DEFAULT_MESSAGE_PAGE_BYTES,
  ): AsyncGenerator<readonly LegacyOpencodeDisplayMessage[], void, void> {
    if (!existsSync(this.daemonPath)) return;
    const Database = this.constructorFor();
    const db = new Database(this.daemonPath, { readonly: true, fileMustExist: true });
    let rows: IterableIterator<unknown> | undefined;
    try {
      const schema = inspectSchema(db);
      if (!canReadMessages(schema)) return;
      const storedId = resolveStoredSessionId(db, schema, sessionId);
      if (!storedId) return;
      rows = messageRows(db, storedId);
      const countLimit = normalizeMessagePageSize(pageSize);
      const byteLimit = normalizeMessagePageBytes(maxPageBytes);
      for (const page of boundedMessagePages(rows, countLimit, byteLimit)) yield page;
    } finally {
      rows?.return?.();
      db.close();
    }
  }
  async listMessagePage(
    sessionId: string,
    options?: number | LegacyOpencodeMessageListOptions,
  ): Promise<LegacyOpencodeMessagePage> {
    return (
      this.withDaemon((db) => {
        const schema = inspectSchema(db);
        if (!canReadMessages(schema)) return { messages: [] };
        const storedId = resolveStoredSessionId(db, schema, sessionId);
        if (!storedId) return { messages: [] };
        const parsed = readMessageRows(db, storedId).map((row) =>
          decodeLegacyDisplayMessage(requireString(row, 'data')),
        );
        return buildLegacyMessagePage(parsed, options);
      }) ?? { messages: [] }
    );
  }
  async countMessages(sessionId: string) {
    return (
      this.withDaemon((db) => {
        const schema = inspectSchema(db);
        if (!canReadMessages(schema)) return 0;
        const storedId = resolveStoredSessionId(db, schema, sessionId);
        if (!storedId) return 0;
        const row = db
          .prepare('SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?')
          .get(storedId);
        return readNumber(row, 'count');
      }) ?? 0
    );
  }
  async scanMessages(sessionId: string): Promise<LegacyOpencodeMessageScan> {
    return (
      this.withDaemon((db) => {
        const schema = inspectSchema(db);
        if (!canReadMessages(schema)) return emptyLegacyMessageScan();
        const storedId = resolveStoredSessionId(db, schema, sessionId);
        if (!storedId) return emptyLegacyMessageScan();
        return scan(messageRows(db, storedId));
      }) ?? emptyLegacyMessageScan()
    );
  }
  async listNativeMessages(
    session: LegacyOpencodeSessionRecord,
  ): Promise<LegacyOpenCodeNativeReadResult | undefined> {
    for (const candidateInput of resolveLegacyNativeCandidateInputs(this.options)) {
      if (!existsSync(candidateInput.dbPath)) continue;
      const candidate = inspectNativeCandidate(candidateInput, this.constructorFor());
      const result = this.withDatabase(candidate.dbPath, (db) =>
        readNative(db, candidate, session.legacyFrameworkSessionId ?? session.sessionId),
      );
      if (result?.messages.length) return result;
    }
    return undefined;
  }
  async getAgent(agentName: string): Promise<LegacyOpencodeAgentRecord | undefined> {
    return this.withDaemon((db) => {
      const schema = inspectSchema(db);
      const columns = schema.tables.get('agents');
      if (!columns?.has('agent_name')) return undefined;
      const row = db.prepare('SELECT * FROM agents WHERE agent_name = ? LIMIT 1').get(agentName);
      const frameworkType = optionalString(row, 'framework_type');
      if (!row || (frameworkType && frameworkType !== 'opencode')) return undefined;
      return decodeLegacyAgentRow(row);
    });
  }
  async getSourceManifest(): Promise<LegacyOpencodeSourceManifest> {
    const walPath = `${this.daemonPath}-wal`;
    const shmPath = `${this.daemonPath}-shm`;
    const candidates = resolveLegacyNativeCandidateInputs(this.options).map((candidate) =>
      inspectNativeCandidate(candidate, this.constructorFor()),
    );
    const sourceOpenCodeDataPath = join(this.options.sourceDataDir, 'opencode', 'data', 'opencode');
    const sourceOpenCodeStatePath = join(
      this.options.sourceDataDir,
      'opencode',
      'state',
      'opencode',
    );
    const sourceOpenCodeXdgDataPath = candidatePath(candidates, 'xdg-data');
    const sourceOpenCodeXdgStatePath = candidatePath(candidates, 'xdg-state');
    const base: LegacyOpencodeSourceManifest = {
      sourceDataDir: this.options.sourceDataDir,
      sourceSqlitePath: this.daemonPath,
      sourceSqliteExists: existsSync(this.daemonPath),
      ...size('sourceSqliteSizeBytes', this.daemonPath),
      sourceSqliteWalPath: walPath,
      sourceSqliteWalExists: existsSync(walPath),
      ...size('sourceSqliteWalSizeBytes', walPath),
      sourceSqliteShmPath: shmPath,
      sourceSqliteShmExists: existsSync(shmPath),
      ...size('sourceSqliteShmSizeBytes', shmPath),
      sourceOpenCodeDataPath,
      sourceOpenCodeDataExists: existsSync(sourceOpenCodeDataPath),
      sourceOpenCodeStatePath,
      sourceOpenCodeStateExists: existsSync(sourceOpenCodeStatePath),
      sourceOpenCodeXdgDataPath,
      sourceOpenCodeXdgDataExists: Boolean(
        sourceOpenCodeXdgDataPath && existsSync(sourceOpenCodeXdgDataPath),
      ),
      sourceOpenCodeXdgStatePath,
      sourceOpenCodeXdgStateExists: Boolean(
        sourceOpenCodeXdgStatePath && existsSync(sourceOpenCodeXdgStatePath),
      ),
      opencodeNative: { candidates },
    };
    if (!existsSync(this.daemonPath)) return base;
    try {
      const details = this.withDatabase(this.daemonPath, (db) => {
        const schema = inspectSchema(db);
        return {
          legacyDaemonSchema: daemonManifest(db, schema),
          tableCounts: tableCounts(db, schema),
        };
      });
      return { ...base, ...details };
    } catch {
      return { ...base, errors: ['legacy_sqlite_unreadable_or_unavailable'] };
    }
  }

  private withDaemon<T>(operation: (db: ReadonlyDatabase) => T): T | undefined {
    if (!existsSync(this.daemonPath)) return undefined;
    return this.withDatabase(this.daemonPath, operation);
  }
  private decodeSession(row: unknown): LegacyOpencodeSessionRecord {
    const session = decodeLegacySessionRow(row);
    if (session.workspaceDir) return session;
    const sessionDataDir = optionalString(row, 'session_data_dir');
    return {
      ...session,
      isDefaultWorkspace: true,
      workspaceDir: sessionDataDir
        ? join(sessionDataDir, 'workspace')
        : join(this.options.sourceDataDir, 'sessions', session.sessionId, 'workspace'),
    };
  }
  private withDatabase<T>(path: string, operation: (db: ReadonlyDatabase) => T): T {
    const Database = this.constructorFor();
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return operation(db);
    } finally {
      db.close();
    }
  }
  private constructorFor(): DatabaseConstructor {
    const overridePath = process.env.MAVIS_SQLITE3_MODULE_PATH?.trim();
    const require = overridePath
      ? createRequire(join(overridePath, 'package.json'))
      : createRequire(import.meta.url);
    const loaded = require('better-sqlite3') as unknown;
    return ((loaded as { default?: DatabaseConstructor }).default ?? loaded) as DatabaseConstructor;
  }
}

function inspectSchema(db: ReadonlyDatabase): LegacyOpencodeTableSchema {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .flatMap((row) => {
      const name = optionalString(row, 'name');
      return name ? [name] : [];
    });
  return {
    tables: new Map(
      names.map((name) => [
        name,
        new Set(
          db
            .prepare(`PRAGMA table_info("${safeIdentifier(name)}")`)
            .all()
            .flatMap((row) => {
              const column = optionalString(row, 'name');
              return column ? [column] : [];
            }),
        ),
      ]),
    ),
  };
}
function canReadSessions(schema: LegacyOpencodeTableSchema) {
  const columns = schema.tables.get('sessions');
  return Boolean(
    columns?.has('session_id') &&
    columns.has('agent_name') &&
    columns.has('session_type') &&
    columns.has('created_at') &&
    columns.has('updated_at'),
  );
}
function canReadMessages(schema: LegacyOpencodeTableSchema) {
  const columns = schema.tables.get('session_messages');
  return Boolean(columns?.has('session_id') && columns.has('data'));
}
function querySessions(
  db: ReadonlyDatabase,
  schema: LegacyOpencodeTableSchema,
  agentName?: string,
) {
  if (!canReadSessions(schema)) return [];
  const statement = db.prepare(
    `SELECT s.*
     FROM sessions s
     ${legacyAgentJoin(schema)}
     WHERE ${legacySessionRuntimeFilter(schema)}${agentName ? ' AND s.agent_name = ?' : ''}`,
  );
  return agentName ? statement.all(agentName) : statement.all();
}
function resolveStoredSessionId(
  db: ReadonlyDatabase,
  schema: LegacyOpencodeTableSchema,
  sessionId: string,
) {
  if (!canReadSessions(schema)) return sessionId;
  const hasFrameworkId = schema.tables.get('sessions')?.has('framework_session_id') ?? false;
  const framework = hasFrameworkId ? 's.framework_session_id' : 'NULL AS framework_session_id';
  const where = hasFrameworkId
    ? 's.session_id = ? OR s.framework_session_id = ?'
    : 's.session_id = ? OR s.session_id = ?';
  const row = db
    .prepare(
      `SELECT s.session_id, ${framework}
       FROM sessions s
       ${legacyAgentJoin(schema)}
       WHERE ${legacySessionRuntimeFilter(schema)} AND (${where})
       LIMIT 1`,
    )
    .get(sessionId, sessionId);
  const storedSessionId = optionalString(row, 'session_id');
  const frameworkSessionId = optionalString(row, 'framework_session_id');
  if (!storedSessionId || !frameworkSessionId || storedSessionId === frameworkSessionId) {
    return storedSessionId;
  }
  if (hasMessageRows(db, storedSessionId)) return storedSessionId;
  return hasMessageRows(db, frameworkSessionId) ? frameworkSessionId : storedSessionId;
}
function hasMessageRows(db: ReadonlyDatabase, sessionId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 AS found FROM session_messages WHERE session_id = ? LIMIT 1')
      .get(sessionId),
  );
}
function legacyAgentJoin(schema: LegacyOpencodeTableSchema): string {
  return hasAgentFramework(schema) ? 'LEFT JOIN agents a ON a.agent_name = s.agent_name' : '';
}
function legacySessionRuntimeFilter(schema: LegacyOpencodeTableSchema): string {
  const sessionFramework = schema.tables.get('sessions')?.has('framework_type') ?? false;
  const agentFramework = hasAgentFramework(schema);
  if (sessionFramework && agentFramework) {
    return `(s.framework_type = 'opencode' OR
      (s.framework_type IS NULL AND (${legacyAgentRuntimePredicate()})))`;
  }
  if (sessionFramework) {
    return "(s.framework_type = 'opencode' OR s.framework_type IS NULL)";
  }
  return agentFramework ? `(${legacyAgentRuntimePredicate()})` : '1 = 1';
}
function hasAgentFramework(schema: LegacyOpencodeTableSchema): boolean {
  const columns = schema.tables.get('agents');
  return Boolean(columns?.has('agent_name') && columns.has('framework_type'));
}
function legacyAgentRuntimePredicate(): string {
  return "a.framework_type = 'opencode' OR a.framework_type IS NULL OR a.agent_name IS NULL";
}
function readMessageRows(db: ReadonlyDatabase, sessionId: string) {
  return db
    .prepare(
      'SELECT rowid AS source_rowid, data FROM session_messages WHERE session_id = ? ORDER BY rowid',
    )
    .all(sessionId);
}
function messageRows(db: ReadonlyDatabase, sessionId: string): IterableIterator<unknown> {
  return db
    .prepare(
      'SELECT rowid AS source_rowid, data FROM session_messages WHERE session_id = ? ORDER BY rowid',
    )
    .iterate(sessionId);
}
function* boundedMessagePages(
  rows: Iterable<unknown>,
  countLimit: number,
  byteLimit: number,
): Generator<readonly LegacyOpencodeDisplayMessage[], void, void> {
  let page: LegacyOpencodeDisplayMessage[] = [];
  let pageBytes = 0;
  for (const row of rows) {
    const raw = requireString(row, 'data');
    const message = decodeLegacyDisplayMessage(raw);
    const rawBytes = Buffer.byteLength(raw, 'utf8');
    if (page.length > 0 && pageBytes + rawBytes > byteLimit) {
      yield page;
      page = [];
      pageBytes = 0;
    }
    page.push(message);
    pageBytes += rawBytes;
    if (page.length >= countLimit || pageBytes >= byteLimit) {
      yield page;
      page = [];
      pageBytes = 0;
    }
  }
  if (page.length > 0) yield page;
}
function scan(rows: Iterable<unknown>): LegacyOpencodeMessageScan {
  return scanLegacyMessageValues(messageData(rows));
}
function* messageData(rows: Iterable<unknown>): Generator<string, void, void> {
  for (const row of rows) yield optionalString(row, 'data') ?? '';
}
function normalizeMessagePageSize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(1000, Math.floor(value)) : 500;
}
function normalizeMessagePageBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MESSAGE_PAGE_BYTES;
}
function inspectNativeCandidate(
  input: LegacyOpenCodeNativeCandidateInput,
  Database: DatabaseConstructor,
): LegacyOpenCodeNativeCandidate {
  const base = {
    kind: input.kind,
    path: dirname(input.dbPath),
    exists: existsSync(dirname(input.dbPath)),
    dbPath: input.dbPath,
    dbExists: existsSync(input.dbPath),
    ...size('dbSizeBytes', input.dbPath),
  };
  if (!base.dbExists) return base;
  try {
    const db = new Database(input.dbPath, { readonly: true, fileMustExist: true });
    try {
      const schema = inspectSchema(db);
      const tables = Object.fromEntries(
        [...schema.tables].map(([name, columns]) => [name, [...columns].sort()]),
      );
      return { ...base, tables, schemaFingerprint: digest(JSON.stringify(tables)) };
    } finally {
      db.close();
    }
  } catch {
    return { ...base, error: 'native_sqlite_unreadable' };
  }
}
function candidatePath(
  candidates: readonly LegacyOpenCodeNativeCandidate[],
  kind: LegacyOpenCodeCandidateKind,
) {
  return candidates.find((candidate) => candidate.kind === kind)?.path ?? '';
}
function readNative(
  db: ReadonlyDatabase,
  candidate: LegacyOpenCodeNativeCandidate,
  sessionId: string,
): LegacyOpenCodeNativeReadResult | undefined {
  const schema = inspectSchema(db);
  const shape = resolveNativeMessageShape(schema);
  if (!shape) return undefined;
  const nativeSessionId = resolveNativeSessionId(db, schema, sessionId);
  const rows = db
    .prepare(
      `SELECT * FROM "${safeIdentifier(shape.messageTable)}"
       WHERE "${safeIdentifier(shape.sessionColumn)}" = ? ${shape.messageOrder}`,
    )
    .all(nativeSessionId);
  if (rows.length === 0) return undefined;
  const messages = rows.map((row) => decodeNativeMessage(db, row, shape));
  return messages.length
    ? { source: candidate, nativeSessionId, messages, warnings: shape.warnings }
    : undefined;
}
function decodeNativeMessage(
  db: ReadonlyDatabase,
  row: unknown,
  shape: NativeMessageShape,
): LegacyOpenCodeNativeMessage {
  if (!isRecord(row)) throw new LegacyOpencodeSourceCorruptionError('native-message');
  const id = readStringField(row, [shape.idColumn, 'id', 'message_id', 'messageID']);
  if (!id) throw new LegacyOpencodeSourceCorruptionError('native-message-id');
  const parsed = parseNativeJson(optionalString(row, 'data'), 'native-message');
  const merged = isRecord(parsed) ? { ...parsed, ...row } : row;
  const partRows = readNativePartRows(db, id, shape);
  const decodedParts = partRows.flatMap(decodeNativePart);
  const parts = decodedParts.length > 0 ? decodedParts : inferNativeParts(row, parsed);
  const role = readStringField(merged, ['role']);
  const model = readStringField(merged, ['model', 'modelID', 'model_id']);
  const provider = readStringField(merged, ['provider', 'providerID', 'provider_id']);
  const api = readStringField(merged, ['api', 'apiID', 'api_id']);
  const timestamp = readNativeTimestamp(merged);
  return {
    id,
    ...optionalProperty('role', role),
    ...optionalProperty('timestamp', timestamp),
    ...optionalProperty('model', model),
    ...optionalProperty('provider', provider),
    ...optionalProperty('api', api),
    parts,
    raw: row,
  };
}
function decodeNativePart(row: unknown): LegacyOpenCodeNativePart[] {
  if (!isRecord(row)) return [];
  const parsed = parseNativeJson(optionalString(row, 'data'), 'native-part');
  const merged = isRecord(parsed) ? { ...parsed, ...row } : row;
  const id = readStringField(merged, ['id']);
  const type = readStringField(merged, ['type']) ?? 'text';
  const text = readStringField(merged, ['text', 'content']);
  const toolCallId = readStringField(merged, [
    'toolCallID',
    'tool_call_id',
    'toolCallId',
    'callID',
    'callId',
    'call_id',
  ]);
  const toolName = readStringField(merged, ['toolName', 'tool_name', 'name', 'tool']);
  const state = readNativeState(parsed);
  const status =
    readStringField(merged, ['status', 'state']) ??
    (typeof state?.status === 'string' ? state.status : undefined);
  const timestamp = readNativeTimestamp(merged);
  return [
    {
      ...optionalProperty('id', id),
      type,
      ...optionalProperty('text', text),
      ...optionalProperty('data', parsed),
      ...optionalProperty('toolCallId', toolCallId),
      ...optionalProperty('toolName', toolName),
      ...optionalProperty('status', status),
      ...optionalProperty('timestamp', timestamp),
      ...optionalProperty('state', state),
      raw: row,
    },
  ];
}

interface NativeMessageShape {
  readonly idColumn: string;
  readonly messageTable: string;
  readonly sessionColumn: string;
  readonly messageOrder: string;
  readonly warnings: readonly string[];
  readonly partTable?: string;
  readonly partShape?: NativePartShape;
}

interface NativePartShape {
  readonly messageColumn: string;
  readonly order: string;
}

function resolveNativeMessageShape(
  schema: LegacyOpencodeTableSchema,
): NativeMessageShape | undefined {
  const messageTable = firstTable(schema, ['message', 'session_message', 'messages']);
  if (!messageTable) return undefined;
  const messageColumns = schema.tables.get(messageTable) ?? new Set<string>();
  const sessionColumn = firstColumn(messageColumns, ['session_id', 'sessionID']);
  const idColumn = firstColumn(messageColumns, ['id', 'message_id', 'messageID']);
  if (!sessionColumn || !idColumn) return undefined;
  const partTable = firstTable(schema, ['part', 'message_part', 'message_parts']);
  const partShape = partTable ? nativePartShape(schema, partTable) : undefined;
  return {
    idColumn,
    messageTable,
    sessionColumn,
    messageOrder: orderBy(messageColumns, [
      'time_created',
      'time',
      'timestamp',
      'created_at',
      'seq',
      idColumn,
    ]),
    warnings: nativeShapeWarnings(partTable, partShape),
    ...optionalProperty('partTable', partTable),
    ...optionalProperty('partShape', partShape),
  };
}

function nativeShapeWarnings(
  partTable: string | undefined,
  partShape: NativePartShape | undefined,
): string[] {
  if (!partTable) return ['legacy_native_schema_missing:part'];
  return partShape ? [] : [`legacy_native_schema_missing:${partTable}.message_id`];
}

function readNativePartRows(
  db: ReadonlyDatabase,
  messageId: string,
  shape: NativeMessageShape,
): unknown[] {
  if (!shape.partTable || !shape.partShape) return [];
  return db
    .prepare(
      `SELECT * FROM "${safeIdentifier(shape.partTable)}"
       WHERE "${safeIdentifier(shape.partShape.messageColumn)}" = ? ${shape.partShape.order}`,
    )
    .all(messageId);
}

function nativePartShape(
  schema: LegacyOpencodeTableSchema,
  table: string,
): NativePartShape | undefined {
  const columns = schema.tables.get(table) ?? new Set<string>();
  const messageColumn = firstColumn(columns, ['message_id', 'messageID', 'message']);
  return messageColumn
    ? {
        messageColumn,
        order: orderBy(columns, ['seq', 'time_created', 'time', 'timestamp', 'created_at', 'id']),
      }
    : undefined;
}

function resolveNativeSessionId(
  db: ReadonlyDatabase,
  schema: LegacyOpencodeTableSchema,
  sessionId: string,
): string {
  const sessionTable = firstTable(schema, ['session', 'sessions']);
  if (!sessionTable) return sessionId;
  const columns = schema.tables.get(sessionTable) ?? new Set<string>();
  const idColumn = firstColumn(columns, ['id', 'session_id', 'sessionID']);
  if (!idColumn) return sessionId;
  const lookupColumns = ['id', 'session_id', 'sessionID', 'parent_id', 'parentID'].filter(
    (column) => columns.has(column),
  );
  for (const lookupColumn of lookupColumns) {
    const row = db
      .prepare(
        `SELECT "${safeIdentifier(idColumn)}" AS id
         FROM "${safeIdentifier(sessionTable)}"
         WHERE "${safeIdentifier(lookupColumn)}" = ? LIMIT 1`,
      )
      .get(sessionId);
    const resolved = optionalString(row, 'id');
    if (resolved) return resolved;
  }
  return sessionId;
}

function inferNativeParts(
  row: Record<string, unknown>,
  parsed: unknown,
): LegacyOpenCodeNativePart[] {
  if (Array.isArray(parsed)) return parsed.flatMap(nativePartFromUnknown);
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.parts)) return parsed.parts.flatMap(nativePartFromUnknown);
    if (Array.isArray(parsed.content)) return parsed.content.flatMap(nativePartFromUnknown);
    if (readStringField(parsed, ['text', 'content'])) return decodeNativePart(parsed);
  }
  const text = readStringField(row, ['text']);
  return text ? [{ type: 'text', text, raw: row }] : [];
}

function nativePartFromUnknown(value: unknown): LegacyOpenCodeNativePart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return isRecord(value) ? decodeNativePart(value) : [];
}

function firstTable(
  schema: LegacyOpencodeTableSchema,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((candidate) => schema.tables.has(candidate));
}

function firstColumn(
  columns: ReadonlySet<string>,
  candidates: readonly string[],
): string | undefined {
  return candidates.find((candidate) => columns.has(candidate));
}

function orderBy(columns: ReadonlySet<string>, candidates: readonly string[]): string {
  const column = firstColumn(columns, candidates);
  return column ? `ORDER BY "${safeIdentifier(column)}" ASC` : '';
}

function readStringField(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

function readNativeTimestamp(value: Readonly<Record<string, unknown>>): number | undefined {
  for (const key of ['time', 'timestamp', 'created_at', 'updated_at']) {
    const timestamp = nativeTimestampValue(value[key]);
    if (timestamp !== undefined) return timestamp;
  }
  const nested = value.time;
  if (isRecord(nested)) {
    for (const key of ['created', 'start', 'completed', 'end', 'updated', 'time']) {
      const timestamp = nativeTimestampValue(nested[key]);
      if (timestamp !== undefined) return timestamp;
    }
  }
  for (const key of ['time_created', 'time_updated']) {
    const timestamp = nativeTimestampValue(value[key]);
    if (timestamp !== undefined) return timestamp;
  }
  return undefined;
}

function nativeTimestampValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readNativeState(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) && isRecord(value.state) ? value.state : undefined;
}

function parseNativeJson(value: string | undefined, source: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new LegacyOpencodeSourceCorruptionError(source);
  }
}

function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function daemonManifest(
  db: ReadonlyDatabase,
  schema: LegacyOpencodeTableSchema,
): LegacyDaemonSchemaManifest {
  const tables = Object.fromEntries(
    [...schema.tables].map(([name, columns]) => [name, [...columns].sort()]),
  );
  const indexRows = db
    .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
    .all();
  const indexes: Record<string, string[]> = {};
  indexRows.forEach((row) => {
    const name = requireString(row, 'name');
    indexes[name] = db
      .prepare(`PRAGMA index_info("${safeIdentifier(name)}")`)
      .all()
      .flatMap((entry) => {
        const column = optionalString(entry, 'name');
        return column ? [column] : [];
      });
  });
  return {
    fingerprint: digest(JSON.stringify({ tables, indexes })),
    tables,
    indexes,
    detectedShape: detectedShape(schema),
  };
}
function detectedShape(
  schema: LegacyOpencodeTableSchema,
): LegacyDaemonSchemaManifest['detectedShape'] {
  if (canReadSessions(schema) && canReadMessages(schema)) return 'legacy-daemon';
  return schema.tables.size > 0 ? 'partial-legacy-daemon' : 'unknown';
}
function tableCounts(db: ReadonlyDatabase, schema: LegacyOpencodeTableSchema) {
  const known = ['sessions', 'session_messages', 'agents'];
  return Object.fromEntries(
    known
      .filter((name) => schema.tables.has(name))
      .map((name) => {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get();
        return [name, readNumber(row, 'count')];
      }),
  );
}
function safeIdentifier(value: string) {
  if (!/^[a-z0-9_]+$/iu.test(value)) throw new Error('Invalid SQLite identifier');
  return value;
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function size<Key extends string>(key: Key, path: string) {
  return existsSync(path) ? ({ [key]: statSync(path).size } as Record<Key, number>) : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasKey(value: unknown, key: string): value is Record<string, unknown> {
  return isRecord(value) && Object.hasOwn(value, key);
}
function optionalString(value: unknown, key: string) {
  return hasKey(value, key) && typeof value[key] === 'string' ? value[key] : undefined;
}
function requireString(value: unknown, key: string) {
  const found = optionalString(value, key);
  if (found === undefined) throw new LegacyOpencodeSourceCorruptionError(key);
  return found;
}
function optionalNumber(value: unknown, key: string) {
  return hasKey(value, key) && typeof value[key] === 'number' ? value[key] : undefined;
}
function readNumber(value: unknown, key: string) {
  const found = optionalNumber(value, key);
  if (found === undefined || !Number.isFinite(found)) {
    throw new LegacyOpencodeSourceCorruptionError(key);
  }
  return found;
}
