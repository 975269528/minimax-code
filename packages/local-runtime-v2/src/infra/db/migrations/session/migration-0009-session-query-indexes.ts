import type { MigrationEntry } from '../../migrate.js';

export const migration: MigrationEntry = {
  version: 9,
  name: 'session_query_indexes',
  up: (database) => {
    database.exec(`
      ALTER TABLE local_runtime_queue_items ADD COLUMN source TEXT;
      ALTER TABLE local_runtime_queue_items ADD COLUMN client_request_id TEXT;
      ALTER TABLE local_runtime_queue_items ADD COLUMN dedupe_key TEXT;
      ALTER TABLE local_runtime_queue_items ADD COLUMN expires_at_ms INTEGER;
      ALTER TABLE local_runtime_queue_items ADD COLUMN claim_id TEXT;
      ALTER TABLE local_runtime_queue_items ADD COLUMN claim_lease_expires_at_ms INTEGER;
      ALTER TABLE local_runtime_queue_items ADD COLUMN routing_fingerprint TEXT;

      UPDATE local_runtime_queue_items
      SET source = coalesce(json_extract(data_json, '$.source'), 'api'),
          client_request_id = json_extract(data_json, '$.clientRequestId'),
          dedupe_key = json_extract(data_json, '$.dedupeKey'),
          expires_at_ms = json_extract(data_json, '$.expiresAt'),
          claim_id = json_extract(data_json, '$.claimId'),
          claim_lease_expires_at_ms = json_extract(data_json, '$.claimLeaseExpiresAt');
    `);

    const rows = database
      .prepare('SELECT id, data_json FROM local_runtime_queue_items ORDER BY id')
      .all();
    const updateRoutingFingerprint = database.prepare(
      'UPDATE local_runtime_queue_items SET routing_fingerprint = ? WHERE id = ?',
    );
    for (const row of rows) {
      const parsed = readQueueRow(row);
      updateRoutingFingerprint.run(queueRoutingFingerprint(parsed.dataJson), parsed.id);
    }

    database.exec(`
      CREATE INDEX idx_local_runtime_queue_items_session_status_id
        ON local_runtime_queue_items(session_id, status, id);
      CREATE INDEX idx_local_runtime_queue_items_session_client_request
        ON local_runtime_queue_items(session_id, client_request_id)
        WHERE client_request_id IS NOT NULL;
      CREATE INDEX idx_local_runtime_queue_items_session_dedupe
        ON local_runtime_queue_items(session_id, dedupe_key)
        WHERE dedupe_key IS NOT NULL;
      CREATE INDEX idx_local_runtime_queue_items_session_claim_id
        ON local_runtime_queue_items(session_id, claim_id, id)
        WHERE claim_id IS NOT NULL;
      CREATE INDEX idx_local_runtime_queue_items_session_routing_id
        ON local_runtime_queue_items(session_id, status, routing_fingerprint, id)
        WHERE routing_fingerprint IS NOT NULL;

      CREATE INDEX idx_local_runtime_token_usage_model_ts
        ON local_runtime_token_usage(model, ts, id);
      CREATE INDEX idx_local_runtime_token_usage_day_ts
        ON local_runtime_token_usage(CAST(ts / 86400000 AS INTEGER), ts, id);
      CREATE INDEX idx_local_runtime_session_assets_session_key_time
        ON local_runtime_session_assets(
          session_id, asset_key, message_created_at_ms DESC, id DESC
        );
    `);
  },
};

function readQueueRow(value: unknown): { readonly id: number; readonly dataJson: string } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !Number.isSafeInteger(value.id) ||
    !('data_json' in value) ||
    typeof value.data_json !== 'string'
  ) {
    throw new Error('Session query index migration encountered an invalid Queue row');
  }
  return { id: value.id as number, dataJson: value.data_json };
}

function queueRoutingFingerprint(dataJson: string): string {
  const parsed: unknown = JSON.parse(dataJson);
  const item = asRecord(parsed);
  const message = asRecord(item.message);
  const messageContext = asOptionalRecord(message.channelContext);
  const context = messageContext ?? asOptionalRecord(item.channelContext);
  const fields = [
    ['source', normalizeRoutingValue(item.source) ?? 'api'],
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

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Session query index migration encountered invalid Queue JSON');
  }
  return value as Readonly<Record<string, unknown>>;
}

function asOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
