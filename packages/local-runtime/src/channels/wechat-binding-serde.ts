import { readFirstString } from '../api/http-helpers.js';
import type { LocalWeChatBindingRecord } from './wechat.js';

/** Local structural guard (kept self-contained so this serde unit has no cycle). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function maskToken(token: string): string {
  if (token.length <= 6) return '***';
  return `${token.slice(0, 3)}***${token.slice(-3)}`;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function normalizeWeChatMode(value: unknown): 'mock' | 'polling' {
  return value === 'polling' ? 'polling' : 'mock';
}

/** Project a stored binding record into the wire shape the channel API returns. */
export function serializeWeChatBinding(record: LocalWeChatBindingRecord): Record<string, unknown> {
  return {
    ok: true,
    platform: 'wechat',
    clientId: record.clientId,
    agentName: record.agentName,
    connected: record.connected,
    enabled: record.enabled,
    mode: record.mode,
    tokenMasked: maskToken(record.botToken),
    hasCredentials: Boolean(record.botToken) && !record.botToken.startsWith('pending:'),
    // `pending` marks an in-progress QR bind (botToken still `pending:<id>`,
    // user has not finished scanning). Surfaced so UI binding-state derivation
    // (`hasBoundChannelForAgent`) can exclude it — a half-started bind must NOT
    // count as "bound", otherwise the connect-mobile page yanks the user to the
    // root session mid-scan and the bind can never complete.
    pending: record.botToken.startsWith('pending:'),
    localRuntime: true,
    // The iLink bot id is a platform identity, not display data. Keep it in
    // the local credential store for transport/reconciliation, but never
    // expose the raw value through Desktop-facing status responses.
    hasIlinkBotId: Boolean(record.ilinkBotId),
    ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    ...(record.webhookToken ? { webhookTokenMasked: maskToken(record.webhookToken) } : {}),
    ...(record.botName ? { botName: record.botName } : {}),
    ...(record.bindSessionId ? { bindSessionId: record.bindSessionId } : {}),
    ...(record.qrcodeUrl ? { qrcodeUrl: record.qrcodeUrl } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Overlay live inbound-monitor health onto a serialized binding so a
 * `connected` binding whose iLink long-poll is dead does not masquerade as
 * healthy in the UI. `status===null` (monitor not yet reported this boot) is
 * treated as optimistic — keep the disk `connected` to avoid a false alarm
 * during the restoreInboundLoops startup race. Mutates `serialized` in place.
 */
export function applyMonitorHealthOverlay(
  serialized: Record<string, unknown>,
  record: Pick<LocalWeChatBindingRecord, 'connected' | 'agentName'>,
  health: { running: boolean; status: string | null } | undefined,
): void {
  if (!record.connected) return;
  const liveStatus = health?.status ?? null;
  if (liveStatus === 'session_expired' || liveStatus === 'stopped') {
    serialized.connected = false;
    serialized.error = 'WeChat receiver offline — reopen WeChat to reconnect';
    serialized.authStatus = 'expired';
  } else if (liveStatus === 'reconnecting') {
    serialized.connected = false;
    serialized.reconnecting = true;
  }
}

/** Parse a loosely-typed persisted/blob value back into a binding record. */
export function normalizeWeChatBinding(
  fallbackClientId: string,
  value: unknown,
): LocalWeChatBindingRecord | undefined {
  if (!isRecord(value)) return undefined;
  const agentName = readFirstString(value, ['agentName', 'agentId', 'agent']);
  const botToken = readFirstString(value, ['botToken', 'token']);
  if (!agentName || !botToken) return undefined;
  const mode = normalizeWeChatMode(readFirstString(value, ['mode']));
  const pending = botToken.startsWith('pending:');
  return {
    clientId: readFirstString(value, ['clientId']) ?? fallbackClientId,
    agentName,
    botToken,
    ...(readFirstString(value, ['ilinkBotId'])
      ? { ilinkBotId: readFirstString(value, ['ilinkBotId']) }
      : {}),
    ...(readFirstString(value, ['baseUrl'])
      ? { baseUrl: readFirstString(value, ['baseUrl']) }
      : {}),
    ...(readFirstString(value, ['webhookToken'])
      ? { webhookToken: readFirstString(value, ['webhookToken']) }
      : {}),
    ...(readFirstString(value, ['botName'])
      ? { botName: readFirstString(value, ['botName']) }
      : {}),
    ...(readFirstString(value, ['bindSessionId'])
      ? { bindSessionId: readFirstString(value, ['bindSessionId']) }
      : {}),
    ...(readFirstString(value, ['qrcodeToken'])
      ? { qrcodeToken: readFirstString(value, ['qrcodeToken']) }
      : {}),
    ...(readFirstString(value, ['qrcodeUrl'])
      ? { qrcodeUrl: readFirstString(value, ['qrcodeUrl']) }
      : {}),
    ...(readFirstString(value, ['getUpdatesBuf'])
      ? { getUpdatesBuf: readFirstString(value, ['getUpdatesBuf']) }
      : {}),
    connected: mode === 'mock' || pending ? false : value.connected !== false,
    enabled: mode === 'mock' || pending ? false : value.enabled !== false,
    mode,
    createdAt: readNumber(value.createdAt) ?? Date.now(),
    updatedAt: readNumber(value.updatedAt) ?? Date.now(),
  };
}
