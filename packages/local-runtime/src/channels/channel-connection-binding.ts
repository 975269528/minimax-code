import { json, readFirstString } from '../api/http-helpers.js';
import { imLogger as logger } from '../common/im-logger.js';

import type { LocalChannelBridgeInfra } from './infra.js';
import { LocalImConnectionError, type LocalImConnectionStore } from './im-connection-store.js';
import type { ChannelPlatform } from './route-api.js';

export interface ImConnectionLink {
  readonly connectionId: string;
  readonly channel: ChannelPlatform;
  readonly agentName: string;
  readonly store: LocalImConnectionStore;
}

type ConnectionBindingLogState = 'start' | 'pending' | 'bound' | 'expired' | 'failed';

export function logConnectionBindingState(
  link: ImConnectionLink,
  state: ConnectionBindingLogState,
  detail: { status?: number; code?: string } = {},
): void {
  const fields = {
    operation: 'binding',
    state,
    connectionId: link.connectionId,
    channel: link.channel,
    agentName: link.agentName,
    ...(detail.status !== undefined ? { status: detail.status } : {}),
    ...(detail.code ? { code: detail.code } : {}),
  };
  if (state === 'failed') {
    logger.warn(fields, 'Channel Connection binding failed');
    return;
  }
  logger.info(fields, 'Channel Connection binding state changed');
}

interface ConnectionBindingTransportApi {
  statusClients(): Promise<Record<string, unknown>>;
  unbind(request: Request): Promise<Response>;
}

type ConnectionBindingCompensation = (clientName: string) => Promise<void>;
type ResolveWriteAgent = (
  infra: LocalChannelBridgeInfra,
  requestedName: string,
  channel: ChannelPlatform,
) => Promise<string>;

interface ConnectionRouteInput {
  readonly infra: LocalChannelBridgeInfra;
}

export async function resolveImConnectionLink(
  input: ConnectionRouteInput,
  body: Record<string, unknown>,
  channel: ChannelPlatform,
  resolveWriteAgent: ResolveWriteAgent,
): Promise<ImConnectionLink | Response | undefined> {
  const connectionId = readFirstString(body, ['connectionId', 'connection_id']);
  if (!connectionId) return undefined;
  return resolveImConnectionId(
    input,
    connectionId,
    channel,
    readExplicitAgentName(body),
    resolveWriteAgent,
  );
}

export async function resolveImConnectionId(
  input: ConnectionRouteInput,
  connectionId: string,
  channel: ChannelPlatform,
  requestedAgentName: string | undefined,
  resolveWriteAgent: ResolveWriteAgent,
): Promise<ImConnectionLink | Response> {
  const store = input.infra.imConnectionStore;
  if (!store) {
    return connectionError(
      503,
      'CHANNEL_CONNECTIONS_UNAVAILABLE',
      'Channel Connections require the Local Runtime V2 Conversation composition.',
    );
  }
  const connection = await store.getConnection(connectionId);
  if (!connection)
    return connectionError(404, 'CHANNEL_CONNECTION_NOT_FOUND', 'Channel Connection not found.');
  if (connection.channel !== channel) {
    return connectionError(409, 'CHANNEL_CONNECTION_CHANNEL_MISMATCH', 'Channel mismatch.');
  }
  if (requestedAgentName) {
    const resolvedAgentName = await resolveWriteAgent(input.infra, requestedAgentName, channel);
    if (resolvedAgentName !== connection.agentName) {
      return connectionError(
        409,
        'CHANNEL_CONNECTION_AGENT_MISMATCH',
        'The requested Agent does not match this Channel Connection.',
      );
    }
  }
  return {
    connectionId: connection.connectionId,
    channel: connection.channel,
    agentName: connection.agentName,
    store,
  };
}

/**
 * Capture the adapter transport view before bind. Snapshotting is important:
 * adapters own this map and may mutate it in place during a successful bind.
 */
export async function captureConnectionBindingCompensation(
  api: ConnectionBindingTransportApi,
  link: ImConnectionLink,
): Promise<ConnectionBindingCompensation> {
  let before: Record<string, unknown>;
  try {
    before = snapshotTransportClients(await api.statusClients());
  } catch {
    throw compensationUnavailable('The Channel transport cannot be inspected for a safe rollback.');
  }
  return async (clientName: string) => {
    // A successful bind may refresh a pre-existing adapter record. Only tear
    // down a client that did not exist before this exact bind attempt; deleting
    // a stale or disabled pre-existing record would be an unsafe rollback.
    if (Object.hasOwn(before, clientName)) return;
    let after: Record<string, unknown>;
    try {
      after = await api.statusClients();
    } catch {
      throw compensationUnavailable(
        'The Channel transport cannot be inspected for a safe rollback.',
      );
    }
    if (!Object.hasOwn(after, clientName) || !isLiveTransport(after[clientName])) {
      throw compensationUnavailable(
        'The Channel transport identity cannot be verified for a safe rollback.',
        502,
      );
    }
    const response = await api.unbind(compensationUnbindRequest(link.channel, link.agentName));
    const payload = await readResponsePayload(response);
    if (!responseSucceeded(response, payload)) {
      throw new LocalImConnectionError(
        response.status || 502,
        'CHANNEL_PLATFORM_COMPENSATION_FAILED',
        'The Channel transport could not be rolled back after local persistence failed.',
      );
    }
  };
}

export async function finishConnectionBinding(
  link: ImConnectionLink,
  response: Response,
  compensate?: ConnectionBindingCompensation,
): Promise<Response> {
  const payload = await readResponsePayload(response);
  if (!responseSucceeded(response, payload)) {
    const code = responseCode(payload, 'CHANNEL_PLATFORM_BIND_FAILED');
    await link.store.markAuthorizationError(link.connectionId, link.channel, code);
    logConnectionBindingState(link, 'failed', { status: response.status, code });
    return responseWithConnectionId(response, payload, link.connectionId);
  }
  const clientName = readFirstString(payload ?? {}, ['clientId', 'client_id']);
  if (!clientName) {
    const code = 'CHANNEL_CLIENT_ID_MISSING';
    await link.store.markAuthorizationError(link.connectionId, link.channel, code);
    logConnectionBindingState(link, 'failed', { status: 502, code });
    return connectionError(
      502,
      code,
      'The Channel bind response did not return a transport client identity.',
    );
  }
  const persistenceError = await persistConnectionBinding(link, clientName, compensate);
  return persistenceError ?? responseWithConnectionId(response, payload, link.connectionId);
}

export async function finishWeChatStart(
  link: ImConnectionLink,
  response: Response,
  compensate?: ConnectionBindingCompensation,
): Promise<Response> {
  const payload = await readResponsePayload(response);
  const status = readFirstString(payload ?? {}, ['status'])?.toLowerCase();
  if (!responseSucceeded(response, payload) || status === 'error') {
    const code = responseCode(payload, 'WECHAT_BIND_START_FAILED');
    await link.store.markAuthorizationError(link.connectionId, 'wechat', code);
    logConnectionBindingState(link, 'failed', { status: response.status, code });
    return responseWithConnectionId(response, payload, link.connectionId);
  }
  if (status === 'expired') {
    await link.store.expireAuthorization(link.connectionId);
    logConnectionBindingState(link, 'expired', {
      status: response.status,
      code: responseCode(payload, 'WECHAT_BIND_EXPIRED'),
    });
    return responseWithConnectionId(response, payload, link.connectionId);
  }
  if (status === 'confirmed' || payload?.connected === true) {
    return finishConnectionBinding(link, response, compensate);
  }
  const platformSessionId = readFirstString(payload ?? {}, ['sessionId', 'session_id']);
  if (!platformSessionId) {
    const code = 'WECHAT_BIND_SESSION_MISSING';
    await link.store.markAuthorizationError(link.connectionId, 'wechat', code);
    logConnectionBindingState(link, 'failed', { status: 502, code });
    return connectionError(502, code, 'WeChat bind start did not return a session.');
  }
  await link.store.beginAuthorization({
    connectionId: link.connectionId,
    channel: 'wechat',
    platformSessionId,
  });
  logConnectionBindingState(link, 'pending', { status: response.status });
  return responseWithConnectionId(response, payload, link.connectionId);
}

export async function readResponsePayload(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  const body = await response
    .clone()
    .json()
    .catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

export function responseSucceeded(
  response: Response,
  payload: Record<string, unknown> | undefined,
): boolean {
  return response.ok && payload?.ok !== false && payload?.status !== 'error';
}

export function responseCode(
  payload: Record<string, unknown> | undefined,
  fallback: string,
): string {
  return readFirstString(payload ?? {}, ['code']) ?? fallback;
}

export function responseWithConnectionId(
  response: Response,
  payload: Record<string, unknown> | undefined,
  connectionId: string,
): Response {
  return payload ? json({ ...payload, connectionId }, { status: response.status }) : response;
}

export function connectionError(status: number, code: string, error: string): Response {
  return json({ ok: false, error, code, localRuntime: true }, { status });
}

export async function persistConnectionBinding(
  link: ImConnectionLink,
  clientName: string,
  compensate?: ConnectionBindingCompensation,
): Promise<Response | undefined> {
  try {
    await link.store.bind({ connectionId: link.connectionId, clientName });
    logConnectionBindingState(link, 'bound');
    return undefined;
  } catch (caught) {
    const persistenceError =
      caught instanceof LocalImConnectionError
        ? caught
        : new LocalImConnectionError(
            500,
            'CHANNEL_CONNECTION_PERSIST_FAILED',
            'The Channel binding could not be persisted locally.',
          );
    await link.store
      .markAuthorizationError(link.connectionId, link.channel, persistenceError.code)
      .catch(() => undefined);
    if (compensate) {
      try {
        await compensate(clientName);
      } catch (caughtCompensation) {
        const error =
          caughtCompensation instanceof LocalImConnectionError
            ? caughtCompensation
            : new LocalImConnectionError(
                502,
                'CHANNEL_PLATFORM_COMPENSATION_FAILED',
                'The Channel transport could not be rolled back after local persistence failed.',
              );
        await link.store
          .markAuthorizationError(link.connectionId, link.channel, error.code)
          .catch(() => undefined);
        logConnectionBindingState(link, 'failed', { status: error.status, code: error.code });
        return connectionError(error.status, error.code, error.message);
      }
    }
    logConnectionBindingState(link, 'failed', {
      status: persistenceError.status,
      code: persistenceError.code,
    });
    return connectionError(
      persistenceError.status,
      persistenceError.code,
      persistenceError.message,
    );
  }
}

function readExplicitAgentName(body: Record<string, unknown>): string | undefined {
  return readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
}

function snapshotTransportClients(clients: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(clients).map(([clientName, status]) => [
      clientName,
      status && typeof status === 'object' && !Array.isArray(status)
        ? { ...(status as Record<string, unknown>) }
        : status,
    ]),
  );
}

function isLiveTransport(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.pending !== true && record.connected !== false;
}

function compensationUnbindRequest(channel: ChannelPlatform, agentName: string): Request {
  return new Request(`http://local-runtime.test/channel-bridge/${channel}/unbind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentName }),
  });
}

function compensationUnavailable(message: string, status = 503): LocalImConnectionError {
  return new LocalImConnectionError(status, 'CHANNEL_PLATFORM_COMPENSATION_UNAVAILABLE', message);
}
