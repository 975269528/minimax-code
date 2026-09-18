import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AgentMessage } from '@mavis/agent-core/protocol/agent-message';

import { loadBetterSqlite3Module } from '../persistence/better-sqlite3-loader.js';
import type {
  LocalSessionRecord,
  LocalSessionStatus,
  LocalSessionType,
} from '../sessions/controller.js';

type DatabaseConstructor = new (
  filename?: string | Buffer,
  options?: Record<string, unknown>,
) => DatabaseLike;

interface DatabaseLike {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    iterate(...args: unknown[]): IterableIterator<unknown>;
  };
  close(): void;
}

interface SessionRow {
  session_id: string;
  framework_session_id: string | null;
  agent_name: string;
  session_type: number;
  title: string | null;
  workspace_dir: string | null;
  status: string | null;
  session_data_dir: string | null;
  compressed: number | null;
  framework_type: string | null;
  parent_session_id: string | null;
  extra_data: string | null;
  pinned: number | null;
  pinned_at: number | null;
  created_at: number | string | null;
  updated_at: number | string | null;
}

interface MessageRow {
  id: number;
  data: string;
}

const DEFAULT_MESSAGE_PAGE_BYTES = 8 * 1024 * 1024;

interface NativeRow extends Record<string, unknown> {
  id?: unknown;
  session_id?: unknown;
  sessionID?: unknown;
  message_id?: unknown;
  messageID?: unknown;
  role?: unknown;
  type?: unknown;
  text?: unknown;
  data?: unknown;
  time?: unknown;
  timestamp?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  model?: unknown;
  provider?: unknown;
  api?: unknown;
  tool_call_id?: unknown;
  toolCallID?: unknown;
  tool_name?: unknown;
  toolName?: unknown;
  state?: unknown;
  status?: unknown;
  error?: unknown;
  seq?: unknown;
}

interface CountRow {
  count?: number;
}

interface TableInfoRow {
  name?: string;
}

interface IndexInfoRow {
  name?: string;
}

interface LogicVersionRow {
  version?: number;
}

type AgentMetadataRow = Record<string, unknown>;

type LegacyTableColumns = Record<string, string[]>;

interface LegacySchema {
  tables: Map<string, Set<string>>;
}

const SQLITE_IN_CHUNK_SIZE = 500;

export interface LegacyOpencodeStoreOptions {
  dataDir: string;
  nowMs?: () => number;
}

export interface LegacyOpencodeMessageListOptions {
  limit?: number;
  before?: string;
}

export interface LegacyOpencodeMessagePage {
  messages: AgentMessage[];
  nextCursor?: string;
}

export interface LegacyOpencodeMessageScan {
  sourceCount: number;
  parseErrorCount: number;
  missingMsgIdCount: number;
  duplicateMsgIdCount: number;
  duplicateSourceMsgIds?: string[];
  rawChecksum: string;
  parsedChecksum: string;
}
export interface LegacyOpencodeSessionRecord extends LocalSessionRecord {
  pinned: boolean; // Legacy source-column value only; migrate to PinService, never clean session storage.
  legacyFrameworkSessionId?: string;
  legacyRawStatus?: string | null;
}

export interface LegacyOpencodeAgentRecord {
  name: string;
  displayName: string;
  description?: string;
  avatar?: string;
  persona?: string;
  systemPrompt?: string;
  defaultWorkspaceDir?: string;
  rootSessionId?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

export interface LegacyOpencodeSourceManifest {
  sourceDataDir: string;
  sourceSqlitePath: string;
  sourceSqliteExists: boolean;
  sourceSqliteSizeBytes?: number;
  sourceSqliteWalPath: string;
  sourceSqliteWalExists: boolean;
  sourceSqliteWalSizeBytes?: number;
  sourceSqliteShmPath: string;
  sourceSqliteShmExists: boolean;
  sourceSqliteShmSizeBytes?: number;
  sourceOpenCodeDataPath: string;
  sourceOpenCodeDataExists: boolean;
  sourceOpenCodeStatePath: string;
  sourceOpenCodeStateExists: boolean;
  sourceOpenCodeXdgDataPath: string;
  sourceOpenCodeXdgDataExists: boolean;
  sourceOpenCodeXdgStatePath: string;
  sourceOpenCodeXdgStateExists: boolean;
  legacyDaemonSchema?: LegacyDaemonSchemaManifest;
  opencodeNative?: LegacyOpenCodeNativeManifest;
  tableCounts?: Record<string, number>;
  errors?: string[];
}

export interface LegacyDaemonSchemaManifest {
  fingerprint: string;
  logicVersion?: number;
  tables: LegacyTableColumns;
  indexes: Record<string, string[]>;
  detectedShape: 'legacy-daemon' | 'partial-legacy-daemon' | 'unknown';
  warnings?: string[];
}

export interface LegacyOpenCodeNativeManifest {
  candidates: LegacyOpenCodeNativeCandidate[];
}

export interface LegacyOpenCodeNativeCandidate {
  kind: 'sandbox-data' | 'sandbox-state' | 'xdg-data' | 'xdg-state';
  path: string;
  exists: boolean;
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes?: number;
  schemaFingerprint?: string;
  tables?: LegacyTableColumns;
  error?: string;
}

export interface LegacyOpenCodeNativeReadResult {
  source: LegacyOpenCodeNativeCandidate;
  nativeSessionId: string;
  messages: LegacyOpenCodeNativeMessage[];
  warnings: string[];
}

export interface LegacyOpenCodeNativeMessage {
  id: string;
  role?: string;
  timestamp?: number;
  model?: string;
  provider?: string;
  api?: string;
  parts: LegacyOpenCodeNativePart[];
  raw?: Record<string, unknown>;
}

export interface LegacyOpenCodeNativePart {
  id?: string;
  type: string;
  text?: string;
  data?: unknown;
  toolCallId?: string;
  toolName?: string;
  status?: string;
  timestamp?: number;
  /**
   * Nested opencode `state` block for `type === 'tool'` parts. Opencode
   * stores tool call + result together inside `part.data.state`:
   *   { status, input, output?, error?, metadata?, time? }
   * The migrator relies on this to split the combined part into a
   * pi-agent `toolCall` content block plus a follow-up `toolResult`
   * message. Retained separately from `data` so downstream code does
   * not need to re-inspect `part.data.state.*` field naming.
   */
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    metadata?: unknown;
  };
  raw?: Record<string, unknown>;
}

export class LegacyOpencodeStore {
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(options: LegacyOpencodeStoreOptions) {
    this.dataDir = options.dataDir;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async getSession(sessionId: string): Promise<LegacyOpencodeSessionRecord | undefined> {
    return this.withDb((db) => {
      const schema = inspectLegacySchema(db);
      if (!canReadLegacySessions(schema)) return undefined;
      const query = buildSessionQuery(schema, {
        where: buildSessionIdWhere(schema),
        orderBy: '',
        limit: 'LIMIT 1',
      });
      const row = db.prepare(query.sql).get(...query.params(sessionId)) as SessionRow | undefined;
      return row ? this.toLocalSession(row) : undefined;
    });
  }

  async listSessions(agentName?: string): Promise<LegacyOpencodeSessionRecord[]> {
    return (
      this.withDb((db) => {
        const schema = inspectLegacySchema(db);
        if (!canReadLegacySessions(schema)) return [];
        const params: unknown[] = [];
        const filters: string[] = [buildRuntimeFilter(schema)];
        if (agentName) {
          filters.push(`${qualifiedColumn('s', 'agent_name')} = ?`);
          params.push(agentName);
        }
        const orderBy = buildSessionOrderBy(schema);
        const query = buildSessionQuery(schema, {
          where: filters.join(' AND '),
          orderBy,
        });
        const rows = db.prepare(query.sql).all(...params) as SessionRow[];
        return rows.map((row) => this.toLocalSession(row));
      }) ?? []
    );
  }

  async listMessages(
    sessionId: string,
    limitOrOptions?: number | LegacyOpencodeMessageListOptions,
  ): Promise<AgentMessage[]> {
    return (await this.listMessagePage(sessionId, limitOrOptions)).messages;
  }

  async listMessagePage(
    sessionId: string,
    limitOrOptions?: number | LegacyOpencodeMessageListOptions,
  ): Promise<LegacyOpencodeMessagePage> {
    return (
      this.withDb((db) => {
        const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
        if (!resolvedSessionId) return { messages: [] };
        return this.listResolvedMessagePage(db, resolvedSessionId, limitOrOptions);
      }) ?? { messages: [] }
    );
  }

  /**
   * Forward-streaming reader over a legacy session's messages, in the same
   * ascending order as {@link listMessages}, yielded one bounded page at a
   * time. The underlying read-only DB handle is opened once for the whole
   * iteration and closed when the generator finishes or the consumer stops
   * early (`for await` + `break`/`return` both trigger the `finally`). Pages are
   * read through better-sqlite3's forward iterator so neither OFFSET rescans nor
   * a second raw-row array stays resident while the consumer writes a page.
   *
   * Both message count and serialized source bytes bound a page. A single row
   * may exceed `maxPageBytes`, but it is yielded alone. Yields nothing when the
   * session or message table is unreadable (same tolerance as
   * {@link listMessagePage}).
   */
  async *streamMessagePages(
    sessionId: string,
    pageSize: number,
    maxPageBytes: number = DEFAULT_MESSAGE_PAGE_BYTES,
  ): AsyncGenerator<AgentMessage[], void, void> {
    const dbPath = path.join(this.dataDir, 'sqlite.db');
    if (!fs.existsSync(dbPath)) return;
    const Database = loadBetterSqlite3();
    if (!Database) return;
    const limit = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 500;
    let db: DatabaseLike;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return;
    }
    let rows: IterableIterator<unknown> | undefined;
    try {
      const schema = inspectLegacySchema(db);
      if (!canReadLegacyMessages(schema)) return;
      const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
      if (!resolvedSessionId) return;
      const idColumn = hasColumn(schema, 'session_messages', 'id') ? 'id' : 'rowid';
      const statement = db.prepare(
        `
        SELECT ${idColumn} AS id, data
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ${idColumn} ASC
      `,
      );
      const byteLimit = normalizeMessagePageBytes(maxPageBytes);
      rows = statement.iterate(resolvedSessionId);
      let page: AgentMessage[] = [];
      let pageBytes = 0;
      for (;;) {
        let next: IteratorResult<unknown> | undefined = rows.next();
        if (next.done) break;
        const parsed = readStreamedMessageRow(next.value as MessageRow);
        next = undefined;
        if (!parsed.message) continue;
        if (page.length > 0 && pageBytes + parsed.rawBytes > byteLimit) {
          const ready = page;
          page = [];
          pageBytes = 0;
          yield ready;
        }
        page.push(parsed.message);
        pageBytes += parsed.rawBytes;
        if (page.length >= limit || pageBytes >= byteLimit) {
          const ready = page;
          page = [];
          pageBytes = 0;
          yield ready;
        }
      }
      if (page.length > 0) yield page;
    } finally {
      rows?.return?.();
      db.close();
    }
  }

  async countMessages(sessionId: string): Promise<number> {
    return (
      this.withDb((db) => {
        const schema = inspectLegacySchema(db);
        if (!canReadLegacyMessages(schema)) return 0;
        const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
        if (!resolvedSessionId) return 0;
        const row = db
          .prepare('SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?')
          .get(resolvedSessionId) as CountRow | undefined;
        return typeof row?.count === 'number' ? row.count : 0;
      }) ?? 0
    );
  }

  async scanMessages(sessionId: string): Promise<LegacyOpencodeMessageScan> {
    return (
      this.withDb((db) => {
        const schema = inspectLegacySchema(db);
        if (!canReadLegacyMessages(schema)) return emptyMessageScan();
        const resolvedSessionId = this.resolveStoredSessionId(db, sessionId);
        if (!resolvedSessionId) return emptyMessageScan();
        const idColumn = hasColumn(schema, 'session_messages', 'id') ? 'id' : 'rowid';
        const rows = db
          .prepare(
            `
            SELECT ${idColumn} AS id, data
            FROM session_messages
            WHERE session_id = ?
            ORDER BY ${idColumn} ASC
          `,
          )
          .iterate(resolvedSessionId) as IterableIterator<MessageRow>;
        return scanMessageRows(rows);
      }) ?? emptyMessageScan()
    );
  }

  async listNativeMessages(
    session: LegacyOpencodeSessionRecord,
  ): Promise<LegacyOpenCodeNativeReadResult | undefined> {
    const manifest = await this.getSourceManifest();
    for (const candidate of manifest.opencodeNative?.candidates ?? []) {
      if (!candidate.dbExists) continue;
      const result = this.withNativeDb(candidate.dbPath, (db) =>
        readNativeMessagesFromDb(db, candidate, session),
      );
      if (result && result.messages.length > 0) return result;
    }
    return undefined;
  }

  async getAgent(agentName: string): Promise<LegacyOpencodeAgentRecord | undefined> {
    return this.withDb((db) => {
      const columns = getTableColumns(db, 'agents');
      if (!columns.has('agent_name')) return undefined;
      const selects = [
        quoteIdentifier('agent_name'),
        selectFirstColumn(columns, ['framework_type'], 'framework_type'),
        selectFirstColumn(columns, ['display_name', 'agent_display_name'], 'display_name'),
        selectFirstColumn(columns, ['description'], 'description'),
        selectFirstColumn(columns, ['avatar'], 'avatar'),
        selectFirstColumn(columns, ['persona'], 'persona'),
        selectFirstColumn(columns, ['system_prompt', 'systemPrompt'], 'system_prompt'),
        selectFirstColumn(
          columns,
          ['default_workspace_dir', 'workspace_dir'],
          'default_workspace_dir',
        ),
        selectFirstColumn(columns, ['main_session_id', 'root_session_id'], 'root_session_id'),
        selectFirstColumn(columns, ['created_at'], 'created_at'),
        selectFirstColumn(columns, ['updated_at'], 'updated_at'),
      ].filter((select): select is string => Boolean(select));
      const row = db
        .prepare(
          `
          SELECT ${selects.join(', ')}
          FROM agents
          WHERE agent_name = ?
          LIMIT 1
        `,
        )
        .get(agentName) as AgentMetadataRow | undefined;
      return row ? toLegacyAgent(row) : undefined;
    });
  }

  async getSourceManifest(): Promise<LegacyOpencodeSourceManifest> {
    const sqlitePath = path.join(this.dataDir, 'sqlite.db');
    const walPath = `${sqlitePath}-wal`;
    const shmPath = `${sqlitePath}-shm`;
    const sourceOpenCodeDataPath = path.join(this.dataDir, 'opencode', 'data', 'opencode');
    const sourceOpenCodeStatePath = path.join(this.dataDir, 'opencode', 'state', 'opencode');
    const sourceOpenCodeXdgDataPath = resolveXdgPath(
      'XDG_DATA_HOME',
      ['.local', 'share'],
      ['opencode'],
    );
    const sourceOpenCodeXdgStatePath = resolveXdgPath(
      'XDG_STATE_HOME',
      ['.local', 'state'],
      ['opencode'],
    );
    const manifest: LegacyOpencodeSourceManifest = {
      sourceDataDir: this.dataDir,
      sourceSqlitePath: sqlitePath,
      sourceSqliteExists: fs.existsSync(sqlitePath),
      ...fileSizeField('sourceSqliteSizeBytes', sqlitePath),
      sourceSqliteWalPath: walPath,
      sourceSqliteWalExists: fs.existsSync(walPath),
      ...fileSizeField('sourceSqliteWalSizeBytes', walPath),
      sourceSqliteShmPath: shmPath,
      sourceSqliteShmExists: fs.existsSync(shmPath),
      ...fileSizeField('sourceSqliteShmSizeBytes', shmPath),
      sourceOpenCodeDataPath,
      sourceOpenCodeDataExists: fs.existsSync(sourceOpenCodeDataPath),
      sourceOpenCodeStatePath,
      sourceOpenCodeStateExists: fs.existsSync(sourceOpenCodeStatePath),
      sourceOpenCodeXdgDataPath,
      sourceOpenCodeXdgDataExists: fs.existsSync(sourceOpenCodeXdgDataPath),
      sourceOpenCodeXdgStatePath,
      sourceOpenCodeXdgStateExists: fs.existsSync(sourceOpenCodeXdgStatePath),
      opencodeNative: inspectOpenCodeNativeSources({
        sandboxDataPath: sourceOpenCodeDataPath,
        sandboxStatePath: sourceOpenCodeStatePath,
        xdgDataPath: sourceOpenCodeXdgDataPath,
        xdgStatePath: sourceOpenCodeXdgStatePath,
      }),
    };
    if (!manifest.sourceSqliteExists) return manifest;
    const sourceDetails = this.withDb((db) => ({
      tableCounts: countKnownLegacyTables(db),
      legacyDaemonSchema: inspectLegacyDaemonSchemaManifest(db),
    }));
    return sourceDetails
      ? { ...manifest, ...sourceDetails }
      : {
          ...manifest,
          errors: ['legacy_sqlite_unreadable_or_unavailable'],
        };
  }

  private listResolvedMessagePage(
    db: DatabaseLike,
    sessionId: string,
    limitOrOptions?: number | LegacyOpencodeMessageListOptions,
  ): LegacyOpencodeMessagePage {
    const schema = inspectLegacySchema(db);
    if (!canReadLegacyMessages(schema)) return { messages: [] };
    const options = normalizeMessageListOptions(limitOrOptions);
    const limit = normalizeMessageLimit(options.limit);
    const before = options.before;
    const idColumn = hasColumn(schema, 'session_messages', 'id') ? 'id' : 'rowid';

    if (!before && limit > 0) {
      const messagesDescending = readLatestParsedMessages(db, {
        sessionId,
        idColumn,
        limit,
      });
      const hasMore = messagesDescending.length > limit;
      const messages = messagesDescending.slice(0, limit).reverse();
      return {
        messages,
        ...(hasMore && messages[0]?.msg_id ? { nextCursor: messages[0].msg_id } : {}),
      };
    }

    const rows = db
      .prepare(
        `
        SELECT ${idColumn} AS id, data
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ${idColumn} ASC
      `,
      )
      .all(sessionId) as MessageRow[];
    const allMessages = rows.flatMap(readMessageRow);
    const beforeIndex = before ? allMessages.findIndex((message) => message.msg_id === before) : -1;
    const visibleMessages = beforeIndex >= 0 ? allMessages.slice(0, beforeIndex) : allMessages;
    if (limit <= 0) return { messages: visibleMessages };

    const start = Math.max(visibleMessages.length - limit, 0);
    const messages = visibleMessages.slice(start);
    const hasMore = start > 0;
    return {
      messages,
      ...(hasMore && messages[0]?.msg_id ? { nextCursor: messages[0].msg_id } : {}),
    };
  }

  private resolveStoredSessionId(db: DatabaseLike, sessionId: string): string | undefined {
    const schema = inspectLegacySchema(db);
    if (!canReadLegacySessions(schema)) return undefined;
    const query = buildSessionIdResolutionQuery(schema);
    const row = db.prepare(query.sql).get(...query.params(sessionId)) as
      | Pick<SessionRow, 'session_id'>
      | undefined;
    return row?.session_id;
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T | undefined {
    const dbPath = path.join(this.dataDir, 'sqlite.db');
    if (!fs.existsSync(dbPath)) return undefined;
    const Database = loadBetterSqlite3();
    if (!Database) return undefined;
    let db: DatabaseLike;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return undefined;
    }
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  private withNativeDb<T>(dbPath: string, fn: (db: DatabaseLike) => T): T | undefined {
    if (!fs.existsSync(dbPath)) return undefined;
    const Database = loadBetterSqlite3();
    if (!Database) return undefined;
    let db: DatabaseLike;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      return undefined;
    }
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  private toLocalSession(row: SessionRow): LegacyOpencodeSessionRecord {
    const createdAt = parseTimestampMs(row.created_at, this.nowMs());
    const updatedAt = parseTimestampMs(row.updated_at, createdAt);
    return {
      sessionId: row.session_id,
      agentName: row.agent_name,
      workspaceDir: row.workspace_dir ?? this.defaultWorkspaceDir(row),
      runtime: 'opencode',
      sessionType: toSessionType(row.session_type),
      archived: row.compressed === 1,
      pinned: row.pinned === 1,
      title: row.title,
      parentSessionId: row.parent_session_id,
      visibility: readVisibility(row.extra_data),
      purpose: readPurpose(row.extra_data),
      status: toLocalStatus(row.status),
      createdAtMs: createdAt,
      updatedAtMs: updatedAt,
      legacyRawStatus: row.status,
      ...(row.framework_session_id ? { legacyFrameworkSessionId: row.framework_session_id } : {}),
    };
  }

  private defaultWorkspaceDir(row: SessionRow): string {
    if (row.session_data_dir) return path.join(row.session_data_dir, 'workspace');
    return path.join(this.dataDir, 'sessions', row.session_id, 'workspace');
  }
}

function readLatestParsedMessages(
  db: DatabaseLike,
  input: { sessionId: string; idColumn: string; limit: number },
): AgentMessage[] {
  const chunkSize = Math.max(input.limit * 4 + 1, 50);
  const messages: AgentMessage[] = [];
  let offset = 0;
  while (messages.length <= input.limit) {
    const rows = db
      .prepare(
        `
        SELECT ${input.idColumn} AS id, data
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ${input.idColumn} DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(input.sessionId, chunkSize, offset) as MessageRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const message = parseMessageRow(row);
      if (message) messages.push(message);
      if (messages.length > input.limit) break;
    }
    offset += rows.length;
    if (rows.length < chunkSize) break;
  }
  return messages;
}

function readNativeMessagesFromDb(
  db: DatabaseLike,
  candidate: LegacyOpenCodeNativeCandidate,
  session: LegacyOpencodeSessionRecord,
): LegacyOpenCodeNativeReadResult | undefined {
  const schema = inspectLegacySchema(db);
  const warnings: string[] = [];
  const nativeSessionId = resolveNativeSessionId(db, schema, session);
  if (!nativeSessionId) return undefined;
  const messageTable = firstExistingTable(schema, ['message', 'session_message', 'messages']);
  const partTable = firstExistingTable(schema, ['part', 'message_part', 'message_parts']);
  if (!messageTable) return undefined;

  const messageColumns = schema.tables.get(messageTable) ?? new Set<string>();
  const messageSessionColumn = firstColumn(messageColumns, ['session_id', 'sessionID']);
  const messageIdColumn = firstColumn(messageColumns, ['id', 'message_id', 'messageID']);
  if (!messageSessionColumn || !messageIdColumn) return undefined;
  const messageOrder = buildNativeOrderBy(messageColumns, [
    // opencode 0.7+ column
    'time_created',
    // legacy candidates + generic fallbacks
    'time',
    'timestamp',
    'created_at',
    'seq',
    'id',
  ]);
  const messageRows = db
    .prepare(
      `
      SELECT *
      FROM ${quoteIdentifier(messageTable)}
      WHERE ${quoteIdentifier(messageSessionColumn)} = ?
      ${messageOrder}
    `,
    )
    .all(nativeSessionId) as NativeRow[];
  if (messageRows.length === 0) return undefined;
  const messageIds = new Set(
    messageRows.flatMap((row) => {
      const id = readStringField(row, [messageIdColumn, 'id', 'message_id', 'messageID']);
      return id ? [id] : [];
    }),
  );

  const partRowsByMessageId = new Map<string, NativeRow[]>();
  if (partTable) {
    const partColumns = schema.tables.get(partTable) ?? new Set<string>();
    const partMessageColumn = firstColumn(partColumns, ['message_id', 'messageID', 'message']);
    if (partMessageColumn) {
      const partOrder = buildNativeOrderBy(partColumns, [
        'seq',
        // opencode 0.7+ column
        'time_created',
        'time',
        'timestamp',
        'created_at',
        'id',
      ]);
      for (const row of readNativePartRowsForMessages(db, {
        partTable,
        partMessageColumn,
        partOrder,
        messageIds: [...messageIds],
      })) {
        const messageId = readStringField(row, [partMessageColumn]);
        if (!messageId) continue;
        const rows = partRowsByMessageId.get(messageId) ?? [];
        rows.push(row);
        partRowsByMessageId.set(messageId, rows);
      }
    } else {
      warnings.push(`legacy_native_schema_missing:${partTable}.message_id`);
    }
  } else {
    warnings.push('legacy_native_schema_missing:part');
  }

  return {
    source: candidate,
    nativeSessionId,
    warnings,
    messages: messageRows.flatMap((row) => {
      const message = nativeMessageFromRow(row, messageIdColumn);
      if (!message) return [];
      const partRows = partRowsByMessageId.get(message.id) ?? [];
      const parts = partRows.flatMap(nativePartFromRow);
      return [
        {
          ...message,
          parts: parts.length > 0 ? parts : inferNativePartsFromMessage(row),
        },
      ];
    }),
  };
}

function readNativePartRowsForMessages(
  db: DatabaseLike,
  input: {
    partTable: string;
    partMessageColumn: string;
    partOrder: string;
    messageIds: string[];
  },
): NativeRow[] {
  if (input.messageIds.length === 0) return [];
  const rows: NativeRow[] = [];
  for (let index = 0; index < input.messageIds.length; index += SQLITE_IN_CHUNK_SIZE) {
    const chunk = input.messageIds.slice(index, index + SQLITE_IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    rows.push(
      ...(db
        .prepare(
          `
          SELECT *
          FROM ${quoteIdentifier(input.partTable)}
          WHERE ${quoteIdentifier(input.partMessageColumn)} IN (${placeholders})
          ${input.partOrder}
        `,
        )
        .all(...chunk) as NativeRow[]),
    );
  }
  return rows;
}

function resolveNativeSessionId(
  db: DatabaseLike,
  schema: LegacySchema,
  session: LegacyOpencodeSessionRecord,
): string | undefined {
  const candidates = [session.legacyFrameworkSessionId, session.sessionId].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const sessionTable = firstExistingTable(schema, ['session', 'sessions']);
  if (!sessionTable) return candidates[0];
  const columns = schema.tables.get(sessionTable) ?? new Set<string>();
  const idColumn = firstColumn(columns, ['id', 'session_id', 'sessionID']);
  if (!idColumn) return candidates[0];
  const parentColumns = ['id', 'session_id', 'sessionID', 'parent_id', 'parentID'].filter(
    (column) => columns.has(column),
  );
  for (const candidate of candidates) {
    for (const column of parentColumns) {
      const row = db
        .prepare(
          `
          SELECT ${quoteIdentifier(idColumn)} AS id
          FROM ${quoteIdentifier(sessionTable)}
          WHERE ${quoteIdentifier(column)} = ?
          LIMIT 1
        `,
        )
        .get(candidate) as { id?: unknown } | undefined;
      const id = typeof row?.id === 'string' ? row.id : undefined;
      if (id) return id;
    }
  }
  return candidates[0];
}

function nativeMessageFromRow(
  row: NativeRow,
  messageIdColumn: string,
): Omit<LegacyOpenCodeNativeMessage, 'parts'> | undefined {
  const id = readStringField(row, [messageIdColumn, 'id', 'message_id', 'messageID']);
  if (!id) return undefined;
  // opencode wraps the message payload (including role/modelID/providerID) in
  // `data`; the outer row only has id / session_id / time_created. Merge so
  // we can read either shape uniformly.
  const parsed = parseNativeJson(readStringField(row, ['data']));
  const merged =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), ...row }
      : row;
  const roleValue = readStringField(merged, ['role']);
  const modelValue = readStringField(merged, ['model', 'modelID', 'model_id']);
  const providerValue = readStringField(merged, ['provider', 'providerID', 'provider_id']);
  const apiValue = readStringField(merged, ['api', 'apiID', 'api_id']);
  const timestamp = readNativeTimestamp(merged);
  return {
    id,
    ...(roleValue ? { role: roleValue } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(modelValue ? { model: modelValue } : {}),
    ...(providerValue ? { provider: providerValue } : {}),
    ...(apiValue ? { api: apiValue } : {}),
    raw: row as Record<string, unknown>,
  };
}

function nativePartFromRow(row: NativeRow): LegacyOpenCodeNativePart[] {
  const parsed = parseNativeJson(readStringField(row, ['data']));
  const merged =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), ...row }
      : row;
  const type = readStringField(merged, ['type']) ?? 'text';
  // Opencode wraps tool-call + tool-result together inside `data.state`. Lift
  // that block up so `convertNativeMessagesToPiHistory` can split it into a
  // pi-agent `toolCall` block plus a follow-up `toolResult` message without
  // re-inspecting field-name variants.
  const state = readNativeToolState(parsed);
  const toolCallId = readStringField(merged, [
    'toolCallID',
    'tool_call_id',
    'toolCallId',
    // opencode: `part.data.callID`
    'callID',
    'callId',
    'call_id',
  ]);
  const toolName = readStringField(merged, [
    'toolName',
    'tool_name',
    'name',
    // opencode: `part.data.tool`
    'tool',
  ]);
  const status =
    readStringField(merged, ['status', 'state']) ??
    (typeof state?.status === 'string' ? state.status : undefined);
  const timestamp = readNativeTimestamp(merged);
  return [
    {
      ...(readStringField(merged, ['id']) ? { id: readStringField(merged, ['id']) } : {}),
      type,
      ...(readStringField(merged, ['text', 'content'])
        ? { text: readStringField(merged, ['text', 'content']) }
        : {}),
      data: parsed ?? readStringField(row, ['data']),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(status ? { status } : {}),
      ...(state ? { state } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      raw: row as Record<string, unknown>,
    },
  ];
}

function inferNativePartsFromMessage(row: NativeRow): LegacyOpenCodeNativePart[] {
  const parsed = parseNativeJson(readStringField(row, ['data']));
  if (Array.isArray(parsed)) return parsed.flatMap((item) => nativePartFromUnknown(item));
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.parts))
      return record.parts.flatMap((item) => nativePartFromUnknown(item));
    if (Array.isArray(record.content))
      return record.content.flatMap((item) => nativePartFromUnknown(item));
    return nativePartFromUnknown(record);
  }
  const text = readStringField(row, ['text', 'data']);
  return text ? [{ type: 'text', text, raw: row as Record<string, unknown> }] : [];
}

function nativePartFromUnknown(value: unknown): LegacyOpenCodeNativePart[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return nativePartFromRow(value as NativeRow);
}

interface SessionQuery {
  sql: string;
  params(sessionId: string): unknown[];
}

function inspectLegacySchema(db: DatabaseLike): LegacySchema {
  const tables = new Map<string, Set<string>>();
  for (const tableName of listUserTables(db)) {
    tables.set(tableName, getTableColumns(db, tableName));
  }
  return { tables };
}

function canReadLegacySessions(schema: LegacySchema): boolean {
  return hasColumn(schema, 'sessions', 'session_id') && hasColumn(schema, 'sessions', 'agent_name');
}

function canReadLegacyMessages(schema: LegacySchema): boolean {
  return (
    hasColumn(schema, 'session_messages', 'session_id') &&
    hasColumn(schema, 'session_messages', 'data')
  );
}

function buildSessionQuery(
  schema: LegacySchema,
  options: { where: string; orderBy?: string; limit?: string },
): SessionQuery {
  const joins = [buildAgentJoin(schema), buildPeerJoin(schema)].filter(Boolean).join('\n');
  const sql = `
    SELECT
      ${buildSessionSelect(schema).join(',\n      ')}
    FROM sessions s
    ${joins}
    WHERE ${options.where}
    ${options.orderBy ?? ''}
    ${options.limit ?? ''}
  `;
  return {
    sql,
    params(sessionId: string) {
      return hasColumn(schema, 'sessions', 'framework_session_id')
        ? [sessionId, sessionId]
        : [sessionId];
    },
  };
}

function buildSessionIdWhere(schema: LegacySchema): string {
  const idPredicates = [`${qualifiedColumn('s', 'session_id')} = ?`];
  if (hasColumn(schema, 'sessions', 'framework_session_id')) {
    idPredicates.push(`${qualifiedColumn('s', 'framework_session_id')} = ?`);
  }
  return `${buildRuntimeFilter(schema)} AND (${idPredicates.join(' OR ')})`;
}

function buildSessionIdResolutionQuery(schema: LegacySchema): SessionQuery {
  return {
    sql: `
      SELECT ${qualifiedColumn('s', 'session_id')} AS session_id
      FROM sessions s
      ${[buildAgentJoin(schema)].filter(Boolean).join('\n')}
      WHERE ${buildSessionIdWhere(schema)}
      LIMIT 1
    `,
    params(sessionId: string) {
      return hasColumn(schema, 'sessions', 'framework_session_id')
        ? [sessionId, sessionId]
        : [sessionId];
    },
  };
}

function buildSessionSelect(schema: LegacySchema): string[] {
  return [
    sessionColumn(schema, 'session_id'),
    sessionColumn(schema, 'framework_session_id'),
    sessionColumn(schema, 'agent_name'),
    sessionColumn(schema, 'session_type', 'session_type', '0'),
    sessionColumn(schema, 'title'),
    sessionColumn(schema, 'workspace_dir'),
    sessionColumn(schema, 'status'),
    sessionColumn(schema, 'session_data_dir'),
    sessionColumn(schema, 'compressed', 'compressed', '0'),
    sessionColumn(schema, 'framework_type'),
    peerColumn(schema, 'parent_session_id'),
    sessionColumn(schema, 'extra_data'),
    sessionColumn(schema, 'pinned', 'pinned', '0'),
    sessionColumn(schema, 'pinned_at'),
    sessionColumn(schema, 'created_at'),
    sessionColumn(schema, 'updated_at'),
  ];
}

function sessionColumn(
  schema: LegacySchema,
  column: string,
  alias = column,
  fallback = 'NULL',
): string {
  return hasColumn(schema, 'sessions', column)
    ? `${qualifiedColumn('s', column)} AS ${quoteIdentifier(alias)}`
    : `${fallback} AS ${quoteIdentifier(alias)}`;
}

function peerColumn(schema: LegacySchema, column: string): string {
  return canJoinSessionPeers(schema)
    ? `${qualifiedColumn('p', column)} AS ${quoteIdentifier(column)}`
    : `NULL AS ${quoteIdentifier(column)}`;
}

function buildAgentJoin(schema: LegacySchema): string {
  return canJoinAgents(schema)
    ? `LEFT JOIN agents a ON ${qualifiedColumn('a', 'agent_name')} = ${qualifiedColumn('s', 'agent_name')}`
    : '';
}

function buildPeerJoin(schema: LegacySchema): string {
  return canJoinSessionPeers(schema)
    ? `LEFT JOIN session_peers p ON ${qualifiedColumn('p', 'session_id')} = ${qualifiedColumn('s', 'session_id')}`
    : '';
}

function canJoinAgents(schema: LegacySchema): boolean {
  return hasColumn(schema, 'agents', 'agent_name');
}

function canJoinSessionPeers(schema: LegacySchema): boolean {
  return (
    hasColumn(schema, 'session_peers', 'session_id') &&
    hasColumn(schema, 'session_peers', 'parent_session_id')
  );
}

function buildRuntimeFilter(schema: LegacySchema): string {
  const sessionFramework = hasColumn(schema, 'sessions', 'framework_type');
  const agentFramework = canJoinAgents(schema) && hasColumn(schema, 'agents', 'framework_type');
  if (sessionFramework && agentFramework) {
    return `(${qualifiedColumn('s', 'framework_type')} = 'opencode' OR (${qualifiedColumn('s', 'framework_type')} IS NULL AND (${legacyAgentFrameworkPredicate()})))`;
  }
  if (sessionFramework) {
    return `(${qualifiedColumn('s', 'framework_type')} = 'opencode' OR ${qualifiedColumn('s', 'framework_type')} IS NULL)`;
  }
  if (agentFramework) {
    return `(${legacyAgentFrameworkPredicate()})`;
  }
  return '1 = 1';
}

function legacyAgentFrameworkPredicate(): string {
  return `${qualifiedColumn('a', 'framework_type')} = 'opencode' OR ${qualifiedColumn('a', 'framework_type')} IS NULL OR ${qualifiedColumn('a', 'agent_name')} IS NULL`;
}

function buildSessionOrderBy(schema: LegacySchema): string {
  const parts = [
    hasColumn(schema, 'sessions', 'session_type')
      ? `${qualifiedColumn('s', 'session_type')} DESC`
      : undefined,
    hasColumn(schema, 'sessions', 'pinned') ? `${qualifiedColumn('s', 'pinned')} DESC` : undefined,
    hasColumn(schema, 'sessions', 'pinned_at')
      ? `${qualifiedColumn('s', 'pinned_at')} DESC`
      : undefined,
    hasColumn(schema, 'sessions', 'updated_at')
      ? `${qualifiedColumn('s', 'updated_at')} DESC`
      : undefined,
    `${qualifiedColumn('s', 'session_id')} ASC`,
  ].filter((part): part is string => Boolean(part));
  return `ORDER BY ${parts.join(', ')}`;
}

function hasColumn(schema: LegacySchema, tableName: string, columnName: string): boolean {
  return schema.tables.get(tableName)?.has(columnName) ?? false;
}

function firstExistingTable(schema: LegacySchema, tableNames: string[]): string | undefined {
  return tableNames.find((tableName) => schema.tables.has(tableName));
}

function firstColumn(columns: Set<string>, columnNames: string[]): string | undefined {
  return columnNames.find((columnName) => columns.has(columnName));
}

function buildNativeOrderBy(columns: Set<string>, candidates: string[]): string {
  const column = firstColumn(columns, candidates);
  return column ? `ORDER BY ${quoteIdentifier(column)} ASC` : '';
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readTimestampField(record: Record<string, unknown>): number | undefined {
  for (const key of ['time', 'timestamp', 'created_at', 'updated_at']) {
    const value = record[key];
    const parsed = parseOptionalTimestampMs(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/**
 * Native opencode timestamps live under three shapes we need to cover:
 * - `time` as scalar ms (older versions);
 * - `time` as object `{ start, end }` (part rows) or `{ created, completed }`
 *   (message rows);
 * - `time_created` / `time_updated` outer columns on message/part rows.
 *
 * `readTimestampField` alone missed both nested and column shapes, which is
 * why migrated rows fell back to the current wall-clock and lost cross-turn
 * ordering. Kept next to it so both helpers evolve together.
 */
function readNativeTimestamp(record: Record<string, unknown>): number | undefined {
  const flat = readTimestampField(record);
  if (flat !== undefined) return flat;
  const nested = record['time'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const scope = nested as Record<string, unknown>;
    for (const key of ['created', 'start', 'completed', 'end', 'updated', 'time']) {
      const value = parseOptionalTimestampMs(scope[key]);
      if (value !== undefined) return value;
    }
  }
  for (const key of ['time_created', 'time_updated']) {
    const value = parseOptionalTimestampMs(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Extract the `state` block from an opencode-native `part.data` payload for
 * `type === 'tool'` parts. Callers get a normalized `{ status, input,
 * output?, error?, metadata? }` object so `convertNativeMessagesToPiHistory`
 * can split a single opencode tool part into pi-agent's separate
 * `toolCall` block + `toolResult` message without re-parsing raw JSON.
 * Returns undefined for non-object / non-state payloads so falsy branches
 * stay simple.
 */
function readNativeToolState(data: unknown): LegacyOpenCodeNativePart['state'] | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const raw = record['state'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const scope = raw as Record<string, unknown>;
  const status = typeof scope['status'] === 'string' ? (scope['status'] as string) : undefined;
  const errorValue = typeof scope['error'] === 'string' ? (scope['error'] as string) : undefined;
  return {
    ...(status ? { status } : {}),
    ...(scope['input'] !== undefined ? { input: scope['input'] } : {}),
    ...(scope['output'] !== undefined ? { output: scope['output'] } : {}),
    ...(errorValue ? { error: errorValue } : {}),
    ...(scope['metadata'] !== undefined ? { metadata: scope['metadata'] } : {}),
  };
}

function parseNativeJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function qualifiedColumn(tableAlias: string, columnName: string): string {
  return `${quoteIdentifier(tableAlias)}.${quoteIdentifier(columnName)}`;
}

function loadBetterSqlite3(): DatabaseConstructor | undefined {
  try {
    return loadBetterSqlite3Module<DatabaseConstructor>();
  } catch {
    return undefined;
  }
}

function toSessionType(value: number): LocalSessionType {
  return value === 1 ? 'root' : 'branch';
}

function toLocalStatus(value: string | null): LocalSessionStatus {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'finished' ||
    normalized === 'error' ||
    normalized === 'aborted' ||
    normalized === 'interrupted'
  ) {
    return normalized;
  }
  if (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'success' ||
    normalized === 'succeeded' ||
    normalized === 'done'
  ) {
    return 'finished';
  }
  if (normalized === 'failed' || normalized === 'failure') return 'error';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'aborted';
  if (!normalized) return 'finished';
  if (
    normalized === 'started' ||
    normalized === 'running' ||
    normalized === 'pending' ||
    normalized === 'partial' ||
    normalized === 'in_progress' ||
    normalized === 'queued' ||
    normalized === 'processing' ||
    normalized === 'streaming' ||
    normalized === 'active'
  ) {
    return 'interrupted';
  }
  return 'interrupted';
}

function parseTimestampMs(value: number | string | null, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toLegacyAgent(row: AgentMetadataRow): LegacyOpencodeAgentRecord | undefined {
  const name = readString(row.agent_name);
  if (!name) return undefined;
  const frameworkType = readString(row.framework_type);
  if (frameworkType && frameworkType !== 'opencode') return undefined;
  const createdAt = parseOptionalTimestampMs(row.created_at);
  const updatedAt = parseOptionalTimestampMs(row.updated_at);
  return {
    name,
    displayName: readString(row.display_name) ?? name,
    ...(readString(row.description) ? { description: readString(row.description) } : {}),
    ...(readString(row.avatar) ? { avatar: readString(row.avatar) } : {}),
    ...(readString(row.persona) ? { persona: readString(row.persona) } : {}),
    ...(readString(row.system_prompt) ? { systemPrompt: readString(row.system_prompt) } : {}),
    ...(readString(row.default_workspace_dir)
      ? { defaultWorkspaceDir: readString(row.default_workspace_dir) }
      : {}),
    ...(readString(row.root_session_id) ? { rootSessionId: readString(row.root_session_id) } : {}),
    ...(createdAt !== undefined ? { createdAtMs: createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAtMs: updatedAt } : {}),
  };
}

function parseOptionalTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getTableColumns(db: DatabaseLike, tableName: string): Set<string> {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as TableInfoRow[])
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string'),
    );
  } catch {
    return new Set();
  }
}

function listUserTables(db: DatabaseLike): string[] {
  try {
    return (
      db
        .prepare(
          `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name ASC
        `,
        )
        .all() as TableInfoRow[]
    )
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

function selectFirstColumn(
  columns: Set<string>,
  candidates: string[],
  alias: string,
): string | undefined {
  const column = candidates.find((candidate) => columns.has(candidate));
  return column ? `${quoteIdentifier(column)} AS ${quoteIdentifier(alias)}` : undefined;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(db: DatabaseLike, tableName: string): boolean {
  try {
    return Boolean(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get(tableName),
    );
  } catch {
    return false;
  }
}

function countKnownLegacyTables(db: DatabaseLike): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tableName of [
    'agents',
    'sessions',
    'session_peers',
    'session_messages',
    'permission_requests',
    'questionnaire_requests',
    'session_turn_file_changes',
    'session_turn_file_change_journal',
    'token_usage',
    'delegation_message',
    'logic_version',
  ]) {
    if (!tableExists(db, tableName)) continue;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`).get() as
      | CountRow
      | undefined;
    counts[tableName] = typeof row?.count === 'number' ? row.count : 0;
  }
  return counts;
}

function inspectLegacyDaemonSchemaManifest(db: DatabaseLike): LegacyDaemonSchemaManifest {
  const schema = inspectLegacySchema(db);
  const tables = tableColumnsRecord(schema);
  const indexes = tableIndexesRecord(db, Object.keys(tables));
  const logicVersion = readLogicVersion(db);
  const warnings = legacyDaemonSchemaWarnings(schema);
  return {
    fingerprint: fingerprintJson({ tables, indexes, logicVersion }),
    ...(logicVersion !== undefined ? { logicVersion } : {}),
    tables,
    indexes,
    detectedShape: detectLegacyDaemonShape(schema),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function tableColumnsRecord(schema: LegacySchema): LegacyTableColumns {
  return Object.fromEntries(
    [...schema.tables.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tableName, columns]) => [tableName, [...columns].sort()]),
  );
}

function tableIndexesRecord(db: DatabaseLike, tableNames: string[]): Record<string, string[]> {
  const indexes: Record<string, string[]> = {};
  for (const tableName of tableNames) {
    try {
      const rows = db
        .prepare(`PRAGMA index_list(${quoteIdentifier(tableName)})`)
        .all() as IndexInfoRow[];
      const names = rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string')
        .sort();
      if (names.length > 0) indexes[tableName] = names;
    } catch {
      // best-effort schema report only
    }
  }
  return indexes;
}

function readLogicVersion(db: DatabaseLike): number | undefined {
  if (!tableExists(db, 'logic_version')) return undefined;
  try {
    const row = db.prepare('SELECT version FROM logic_version WHERE id = 1').get() as
      | LogicVersionRow
      | undefined;
    return typeof row?.version === 'number' ? row.version : undefined;
  } catch {
    return undefined;
  }
}

function detectLegacyDaemonShape(
  schema: LegacySchema,
): LegacyDaemonSchemaManifest['detectedShape'] {
  if (canReadLegacySessions(schema) && canReadLegacyMessages(schema)) return 'legacy-daemon';
  if (schema.tables.has('sessions') || schema.tables.has('session_messages')) {
    return 'partial-legacy-daemon';
  }
  return 'unknown';
}

function legacyDaemonSchemaWarnings(schema: LegacySchema): string[] {
  const warnings: string[] = [];
  if (!schema.tables.has('sessions')) warnings.push('legacy_schema_missing:sessions');
  if (!schema.tables.has('session_messages'))
    warnings.push('legacy_schema_missing:session_messages');
  if (!hasColumn(schema, 'sessions', 'framework_session_id')) {
    warnings.push('legacy_schema_missing:sessions.framework_session_id');
  }
  if (!schema.tables.has('agents')) warnings.push('legacy_schema_missing:agents');
  if (!schema.tables.has('session_peers')) warnings.push('legacy_schema_missing:session_peers');
  return warnings;
}

function inspectOpenCodeNativeSources(input: {
  sandboxDataPath: string;
  sandboxStatePath: string;
  xdgDataPath: string;
  xdgStatePath: string;
}): LegacyOpenCodeNativeManifest {
  const candidates: LegacyOpenCodeNativeCandidate[] = [
    inspectOpenCodeNativeCandidate('sandbox-data', input.sandboxDataPath),
    inspectOpenCodeNativeCandidate('sandbox-state', input.sandboxStatePath),
    inspectOpenCodeNativeCandidate('xdg-data', input.xdgDataPath),
    inspectOpenCodeNativeCandidate('xdg-state', input.xdgStatePath),
  ];
  return { candidates };
}

function inspectOpenCodeNativeCandidate(
  kind: LegacyOpenCodeNativeCandidate['kind'],
  candidatePath: string,
): LegacyOpenCodeNativeCandidate {
  const dbPath = path.join(candidatePath, 'opencode.db');
  const base: LegacyOpenCodeNativeCandidate = {
    kind,
    path: candidatePath,
    exists: fs.existsSync(candidatePath),
    dbPath,
    dbExists: fs.existsSync(dbPath),
    ...fileSizeField('dbSizeBytes', dbPath),
  };
  if (!base.dbExists) return base;
  const details = inspectSqliteSchemaFile(dbPath);
  return { ...base, ...details };
}

function inspectSqliteSchemaFile(
  dbPath: string,
): Pick<LegacyOpenCodeNativeCandidate, 'schemaFingerprint' | 'tables' | 'error'> {
  const Database = loadBetterSqlite3();
  if (!Database) return { error: 'better_sqlite3_unavailable' };
  let db: DatabaseLike;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const schema = inspectLegacySchema(db);
    const tables = tableColumnsRecord(schema);
    return {
      tables,
      schemaFingerprint: fingerprintJson({ tables }),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    db.close();
  }
}

function resolveXdgPath(envName: string, defaultParts: string[], childParts: string[]): string {
  const base =
    typeof process.env[envName] === 'string' && process.env[envName]?.trim()
      ? process.env[envName]!
      : path.join(os.homedir(), ...defaultParts);
  return path.join(base, ...childParts);
}

function fingerprintJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileSizeField(key: string, filePath: string): Record<string, number> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return { [key]: fs.statSync(filePath).size };
  } catch {
    return {};
  }
}

function parseExtraData(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readVisibility(raw: string | null): 'visible' | 'hidden' {
  const value = parseExtraData(raw).visibility;
  return value === 'hidden' ? 'hidden' : 'visible';
}

function readPurpose(raw: string | null): string | undefined {
  const value = parseExtraData(raw).purpose;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeMessageListOptions(
  limitOrOptions?: number | LegacyOpencodeMessageListOptions,
): LegacyOpencodeMessageListOptions {
  return typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : (limitOrOptions ?? {});
}

function normalizeMessageLimit(limit: number | undefined): number {
  return Number.isFinite(limit) && (limit ?? 0) > 0 ? Math.floor(limit!) : 0;
}

function normalizeMessagePageBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MESSAGE_PAGE_BYTES;
}

function readMessageRow(row: MessageRow): AgentMessage[] {
  const message = parseMessageRow(row);
  return message ? [message] : [];
}

function readStreamedMessageRow(row: MessageRow): {
  message: AgentMessage | undefined;
  rawBytes: number;
} {
  return {
    message: parseMessageRow(row),
    rawBytes: Buffer.byteLength(row.data, 'utf8'),
  };
}

function parseMessageRow(row: MessageRow): AgentMessage | undefined {
  try {
    const parsed = JSON.parse(row.data) as unknown;
    return isLegacyMessageObject(parsed) ? (parsed as unknown as AgentMessage) : undefined;
  } catch {
    return undefined;
  }
}

function isLegacyMessageObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function emptyMessageScan(): LegacyOpencodeMessageScan {
  const emptyChecksum = fingerprintJson([]);
  return {
    sourceCount: 0,
    parseErrorCount: 0,
    missingMsgIdCount: 0,
    duplicateMsgIdCount: 0,
    duplicateSourceMsgIds: [],
    rawChecksum: emptyChecksum,
    parsedChecksum: emptyChecksum,
  };
}

function scanMessageRows(rows: Iterable<MessageRow>): LegacyOpencodeMessageScan {
  const rawHash = crypto.createHash('sha256');
  const parsedHash = crypto.createHash('sha256');
  parsedHash.update('[');
  let sourceCount = 0;
  let parsedCount = 0;
  let parseErrorCount = 0;
  let missingMsgIdCount = 0;
  let duplicateMsgIdCount = 0;
  const seen = new Set<string>();
  const duplicateSourceMsgIds = new Set<string>();
  for (const row of rows) {
    sourceCount += 1;
    rawHash.update(String(row.id));
    rawHash.update('\0');
    rawHash.update(row.data);
    rawHash.update('\n');
    const message = parseMessageRow(row);
    if (!message) {
      parseErrorCount += 1;
      continue;
    }
    if (parsedCount > 0) parsedHash.update(',');
    parsedHash.update(JSON.stringify(message));
    parsedCount += 1;
    const msgId = typeof message.msg_id === 'string' ? message.msg_id : '';
    if (!msgId) {
      missingMsgIdCount += 1;
    } else if (seen.has(msgId)) {
      duplicateMsgIdCount += 1;
      if (msgId.trim()) duplicateSourceMsgIds.add(msgId);
    } else {
      seen.add(msgId);
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
