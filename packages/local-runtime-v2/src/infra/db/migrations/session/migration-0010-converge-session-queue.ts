import type { MigrationDatabase, MigrationEntry } from '../../migrate.js';

interface QueueRow {
  readonly sessionId: string;
  readonly itemId: string;
  readonly dataJson: string;
}

interface QueueItem extends Record<string, unknown> {
  readonly itemId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly source: string;
  readonly status: 'queued' | 'claimed';
  readonly message: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

type QueueQuarantineSource = 'legacy-blob' | 'legacy-item' | 'current-row';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'expired', 'cancelled', 'injected']);
const SOURCES = new Set([
  'api',
  'cron',
  'task',
  'background-task',
  'team',
  'thread-goal',
  'questionnaire',
  'communication',
  'greeting',
  'channel:wechat',
  'channel:feishu',
  'channel:telegram',
]);

export const migration: MigrationEntry = {
  version: 10,
  name: 'converge_session_queue',
  up: (database) => {
    createQuarantineStorage(database);
    const legacyBySession = readLegacy(database);
    const currentBySession = readCurrent(database);
    const sessionIds = new Set([...legacyBySession.keys(), ...currentBySession.keys()]);
    for (const sessionId of [...sessionIds].sort()) {
      const legacy = parseLegacyBlob(database, sessionId, legacyBySession.get(sessionId));
      const current = (currentBySession.get(sessionId) ?? []).flatMap((row) => {
        const item = resolveOrQuarantine(
          database,
          {
            sessionId,
            sourceKind: 'current-row',
            sourceKey: row.itemId,
            rawJson: row.dataJson,
          },
          () => resolveItem(row.dataJson, row.sessionId, row.itemId),
        );
        return item ? [item] : [];
      });
      const merged = mergeItems(legacy, current);
      replaceSession(database, sessionId, merged);
      markReady(database, sessionId, merged);
      database.prepare('DELETE FROM local_runtime_queues WHERE session_id = ?').run(sessionId);
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_runtime_queue_items_session_status_expiry_id
        ON local_runtime_queue_items(session_id, status, id, expires_at_ms);
    `);
  },
};

function createQuarantineStorage(database: MigrationDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_queue_migration_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_key TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      error TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS local_runtime_queue_migration_quarantine_source
      ON local_runtime_queue_migration_quarantine(session_id, source_kind, source_key);
  `);
}

function readLegacy(database: MigrationDatabase): Map<string, string> {
  const result = new Map<string, string>();
  for (const value of database
    .prepare('SELECT session_id, items_json FROM local_runtime_queues ORDER BY session_id')
    .all()) {
    const row = asRecord(value, 'legacy Queue row');
    const sessionId = requiredString(row.session_id, 'legacy Queue session_id');
    const itemsJson = requiredString(row.items_json, 'legacy Queue items_json');
    result.set(sessionId, itemsJson);
  }
  return result;
}

function readCurrent(database: MigrationDatabase): Map<string, QueueRow[]> {
  const result = new Map<string, QueueRow[]>();
  for (const value of database
    .prepare(
      `SELECT session_id, item_id, data_json
       FROM local_runtime_queue_items
       ORDER BY session_id, id`,
    )
    .all()) {
    const row = asRecord(value, 'current Queue row');
    const current: QueueRow = {
      sessionId: requiredString(row.session_id, 'current Queue session_id'),
      itemId: requiredString(row.item_id, 'current Queue item_id'),
      dataJson: requiredString(row.data_json, 'current Queue data_json'),
    };
    result.set(current.sessionId, [...(result.get(current.sessionId) ?? []), current]);
  }
  return result;
}

function parseLegacyBlob(
  database: MigrationDatabase,
  sessionId: string,
  raw: string | undefined,
): QueueItem[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    quarantine(database, {
      sessionId,
      sourceKind: 'legacy-blob',
      sourceKey: 'blob',
      rawJson: raw,
      error: new Error(`Queue migration encountered invalid legacy JSON: ${sessionId}`, {
        cause: error,
      }),
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    quarantine(database, {
      sessionId,
      sourceKind: 'legacy-blob',
      sourceKey: 'blob',
      rawJson: raw,
      error: new Error(`Queue migration encountered a non-array legacy blob: ${sessionId}`),
    });
    return [];
  }
  return parsed.flatMap((candidate, index) => {
    const candidateJson = JSON.stringify(candidate);
    const item = resolveOrQuarantine(
      database,
      {
        sessionId,
        sourceKind: 'legacy-item',
        sourceKey: String(index),
        rawJson: candidateJson,
      },
      () => resolveItem(candidateJson, sessionId),
    );
    return item ? [item] : [];
  });
}

function resolveOrQuarantine(
  database: MigrationDatabase,
  source: {
    readonly sessionId: string;
    readonly sourceKind: QueueQuarantineSource;
    readonly sourceKey: string;
    readonly rawJson: string;
  },
  resolve: () => QueueItem | undefined,
): QueueItem | undefined {
  try {
    return resolve();
  } catch (error) {
    quarantine(database, { ...source, error });
    return undefined;
  }
}

function quarantine(
  database: MigrationDatabase,
  entry: {
    readonly sessionId: string;
    readonly sourceKind: QueueQuarantineSource;
    readonly sourceKey: string;
    readonly rawJson: string;
    readonly error: unknown;
  },
): void {
  database
    .prepare(
      `INSERT INTO local_runtime_queue_migration_quarantine(
         session_id, source_kind, source_key, raw_json, error
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, source_kind, source_key) DO UPDATE SET
         raw_json = excluded.raw_json,
         error = excluded.error`,
    )
    .run(
      entry.sessionId,
      entry.sourceKind,
      entry.sourceKey,
      entry.rawJson,
      errorMessage(entry.error),
    );
}

function resolveItem(
  raw: string,
  expectedSessionId: string,
  expectedItemId?: string,
): QueueItem | undefined {
  const item = parseQueueItem(raw, expectedSessionId);
  const identity = readQueueIdentity(item, expectedSessionId, expectedItemId);
  const status = normalizeQueueStatus(item.status);
  if (status === undefined) return undefined;
  const source = readQueueSource(item.source);
  return buildQueueItem(item, identity, status, source);
}

function parseQueueItem(raw: string, expectedSessionId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Queue migration encountered invalid item JSON: ${expectedSessionId}`);
  }
  return asRecord(parsed, 'Queue item');
}

function readQueueIdentity(
  item: Readonly<Record<string, unknown>>,
  expectedSessionId: string,
  expectedItemId?: string,
): { readonly itemId: string; readonly sessionId: string } {
  const itemId = requiredString(item.itemId, 'Queue itemId');
  const sessionId = requiredString(item.sessionId, 'Queue sessionId');
  if (
    sessionId !== expectedSessionId ||
    (expectedItemId !== undefined && itemId !== expectedItemId)
  ) {
    throw new Error(
      `Queue migration encountered Queue row identity mismatch: ${expectedSessionId}/${expectedItemId ?? itemId}`,
    );
  }
  return { itemId, sessionId };
}

function normalizeQueueStatus(value: unknown): QueueItem['status'] | undefined {
  const status = requiredString(value, 'Queue status');
  if (TERMINAL_STATUSES.has(status)) return undefined;
  if (status === 'running' || status === 'queued') return 'queued';
  if (status === 'claimed') return status;
  throw new Error(`Queue migration encountered invalid Queue status: ${status}`);
}

function readQueueSource(value: unknown): string {
  const source = requiredString(value, 'Queue source');
  if (!SOURCES.has(source))
    throw new Error(`Queue migration encountered invalid Queue source: ${source}`);
  return source;
}

function buildQueueItem(
  item: Readonly<Record<string, unknown>>,
  identity: { readonly itemId: string; readonly sessionId: string },
  status: QueueItem['status'],
  source: string,
): QueueItem {
  const agentName = requiredString(item.agentName, 'Queue agentName');
  const message = readMessage(item.message);
  const createdAt = finiteNumber(item.createdAt, 'Queue createdAt');
  const result: Record<string, unknown> = {
    ...identity,
    agentName,
    source,
    status,
    message,
    createdAt,
  };
  const context = readOptionalContext(item.channelContext);
  if (context) result.channelContext = context;
  const model = readOptionalModel(item.model);
  if (model) result.model = model;
  assignOptionalString(result, 'requestedTurnId', item.requestedTurnId, 'Queue requestedTurnId');
  assignOptionalString(result, 'clientRequestId', item.clientRequestId, 'Queue clientRequestId');
  assignOptionalString(result, 'dedupeKey', item.dedupeKey, 'Queue dedupeKey');
  const expiresAt = optionalFinite(item.expiresAt, 'Queue expiresAt');
  if (expiresAt !== undefined) result.expiresAt = expiresAt;
  if (status === 'claimed') assignClaimFields(result, item);
  return result as QueueItem;
}

function assignOptionalString(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  label: string,
): void {
  const normalized = optionalString(value, label);
  if (normalized) target[key] = normalized;
}

function assignClaimFields(
  target: Record<string, unknown>,
  item: Readonly<Record<string, unknown>>,
): void {
  target.claimId = requiredString(item.claimId, 'Queue claimId');
  target.claimedAt = finiteNumber(item.claimedAt, 'Queue claimedAt');
  assignOptionalString(target, 'claimOwnerId', item.claimOwnerId, 'Queue claimOwnerId');
  const lease = optionalFinite(item.claimLeaseExpiresAt, 'Queue claimLeaseExpiresAt');
  if (lease !== undefined) target.claimLeaseExpiresAt = lease;
}

function readMessage(value: unknown): Readonly<Record<string, unknown>> {
  const message = asRecord(value, 'Queue message');
  if (typeof message.content !== 'string' || !Array.isArray(message.attachments)) {
    throw new Error('Queue migration encountered invalid Queue message');
  }
  for (const attachment of message.attachments) readAttachment(attachment);
  if (message.hideUserMessage !== undefined && typeof message.hideUserMessage !== 'boolean') {
    throw new Error('Queue migration encountered invalid hideUserMessage');
  }
  for (const key of ['displayContent', 'queueItemId', 'source']) {
    optionalString(message[key], `Queue message ${key}`);
  }
  if (message.quotedMessage !== undefined) {
    const quoted = asRecord(message.quotedMessage, 'Queue quotedMessage');
    if (typeof quoted.text !== 'string')
      throw new Error('Queue migration encountered invalid quote');
    optionalString(quoted.senderName, 'Queue quoted senderName');
  }
  readOptionalContext(message.channelContext);
  return message;
}

function readAttachment(value: unknown): void {
  const attachment = asRecord(value, 'Queue attachment');
  if (
    (attachment.type !== 'file' && attachment.type !== 'image') ||
    typeof attachment.filePath !== 'string' ||
    typeof attachment.fileName !== 'string' ||
    typeof attachment.mimeType !== 'string'
  ) {
    throw new Error('Queue migration encountered invalid Queue attachment');
  }
  for (const key of ['dataUrl', 'assetId', 'error']) {
    optionalString(attachment[key], `Queue attachment ${key}`);
  }
}

function readOptionalContext(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const context = asRecord(value, 'Queue channelContext');
  for (const key of ['platform', 'chatType', 'chatId', 'senderId', 'clientName']) {
    if (typeof context[key] !== 'string') {
      throw new Error(`Queue migration encountered invalid channelContext ${key}`);
    }
  }
  for (const key of ['threadId', 'channel', 'channel_id']) {
    optionalString(context[key], `Queue channelContext ${key}`);
  }
  return context;
}

function readOptionalModel(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const model = asRecord(value, 'Queue model');
  for (const key of ['provider_id', 'model_id', 'variant']) {
    optionalString(model[key], `Queue model ${key}`);
  }
  return model;
}

function mergeItems(legacy: readonly QueueItem[], current: readonly QueueItem[]): QueueItem[] {
  return current.reduce<QueueItem[]>(
    (items, item) => {
      const existing = items.findIndex((candidate) => candidate.itemId === item.itemId);
      if (existing < 0) return [...items, item];
      return items.map((candidate, index) => (index === existing ? item : candidate));
    },
    [...legacy],
  );
}

function replaceSession(
  database: MigrationDatabase,
  sessionId: string,
  items: readonly QueueItem[],
): void {
  database.prepare('DELETE FROM local_runtime_queue_items WHERE session_id = ?').run(sessionId);
  const insert = database.prepare(
    `INSERT INTO local_runtime_queue_items(
       session_id, item_id, status, created_at_ms, data_json,
       source, client_request_id, dedupe_key, expires_at_ms,
       claim_id, claim_lease_expires_at_ms, routing_fingerprint
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    insert.run(
      item.sessionId,
      item.itemId,
      item.status,
      item.createdAt,
      JSON.stringify(item),
      item.source,
      item.clientRequestId ?? null,
      item.dedupeKey ?? null,
      item.expiresAt ?? null,
      item.claimId ?? null,
      item.claimLeaseExpiresAt ?? null,
      routingFingerprint(item),
    );
  }
}

function markReady(
  database: MigrationDatabase,
  sessionId: string,
  items: readonly QueueItem[],
): void {
  const marker = items.reduce((latest, item) => Math.max(latest, item.createdAt), 0);
  database
    .prepare(
      `INSERT INTO local_runtime_queue_row_migrations(session_id, queue_rows_backfilled_at_ms)
       VALUES (?, ?)
       ON CONFLICT(session_id) DO NOTHING`,
    )
    .run(sessionId, marker);
}

function routingFingerprint(item: QueueItem): string {
  const messageContext = asOptionalRecord(item.message.channelContext);
  const context = messageContext ?? asOptionalRecord(item.channelContext);
  const fields = [
    ['source', normalizeRoutingValue(item.source)],
    ['platform', readRoutingValue(context, ['platform'])],
    ['client', readRoutingValue(context, ['clientName', 'client_name', 'client'])],
    ['agent', normalizeRoutingValue(item.agentName)],
    ['agentBinding', readRoutingValue(context, ['agentName', 'agent_name', 'agentId', 'agent_id'])],
    ['binding', readRoutingValue(context, ['bindingId', 'binding_id'])],
    ['channel', readRoutingValue(context, ['channel'])],
    ['channelId', readRoutingValue(context, ['channel_id', 'channelId'])],
    ['thread', readRoutingValue(context, ['threadId', 'thread_id'])],
    ['chat', readRoutingValue(context, ['chatId', 'chat_id'])],
    ['scope', readRoutingValue(context, ['scope', 'scopeId', 'scope_id'])],
    ['chatType', readRoutingValue(context, ['chatType', 'chat_type'])],
    ['sender', readRoutingValue(context, ['senderId', 'sender_id'])],
  ] as const;
  return `queue-routing/v1:${JSON.stringify(fields)}`;
}

function readRoutingValue(
  context: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): string | null {
  if (!context) return null;
  for (const key of keys) {
    const value = normalizeRoutingValue(context[key]);
    if (value !== null) return value;
  }
  return null;
}

function normalizeRoutingValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function asOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Queue migration encountered invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Queue migration encountered invalid ${label}`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`Queue migration encountered invalid ${label}`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Queue migration encountered invalid ${label}`);
  }
  return value;
}

function optionalFinite(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
