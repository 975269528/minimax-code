import { json, readFirstString, readJsonBody } from '../api/http-helpers.js';
import { LocalAgentContractError, validateAgentName } from '../agent/contract.js';
import { normalizePrimaryAgentResolutionConflict } from '../api/host-channel-family-gate.js';
import {
  captureConnectionBindingCompensation,
  connectionError,
  finishConnectionBinding,
  finishWeChatStart,
  logConnectionBindingState,
  persistConnectionBinding,
  readResponsePayload,
  resolveImConnectionId,
  resolveImConnectionLink,
  responseCode,
  responseSucceeded,
  responseWithConnectionId,
} from './channel-connection-binding.js';
import {
  bindAgentDefaultChannelBinding,
  deleteAgentPlatformChannelBindings,
} from './default-channel-binding.js';
import type { LocalFeishuChannelApi } from './feishu.js';
import { readFeishuAgentName } from './feishu.js';
import type { LocalChannelBridgeInfra } from './infra.js';
import { LocalImConnectionError } from './im-connection-store.js';
import type { LocalChannelRunner } from './runner.js';
import type { ChannelPlatform } from './route-api.js';
import type { LocalTelegramChannelApi } from './telegram.js';
import type { LocalWeChatChannelApi } from './wechat.js';

export async function routeLocalChannelBindApi(input: {
  request: Request;
  method: string;
  joined: string;
  infra: LocalChannelBridgeInfra;
  runner?: LocalChannelRunner;
  feishu?: LocalFeishuChannelApi;
  telegram?: LocalTelegramChannelApi;
  wechat?: LocalWeChatChannelApi;
}): Promise<Response | undefined> {
  try {
    if (input.method === 'GET' && input.joined === 'wechat/bind/status')
      return bindWeChatStatus(input);
    if (input.method !== 'POST') return undefined;
    if (input.joined === 'connect') return bindFeishuConnect(input);
    if (input.joined === 'disconnect') return disconnectChannel(input);
    if (input.joined === 'telegram/bind') return bindTelegram(input);
    if (input.joined === 'feishu/bind') return bindFeishu(input);
    if (input.joined === 'feishu/unbind') return unbindFeishu(input);
    if (input.joined === 'wechat/bind') return bindWeChat(input, 'bind');
    if (input.joined === 'wechat/unbind') return unbindWeChat(input);
    if (input.joined === 'wechat/bind/start') return bindWeChat(input, 'start');
    return undefined;
  } catch (error) {
    if (error instanceof LocalImConnectionError || error instanceof LocalAgentContractError) {
      return connectionError(error.status, error.code, error.message);
    }
    throw error;
  }
}

type BindRouteInput = Parameters<typeof routeLocalChannelBindApi>[0];

async function bindFeishuConnect(input: BindRouteInput): Promise<Response> {
  const body = await readJsonBody(input.request);
  // Preserve the historical probe envelope for unrecognised connect bodies.
  if (!input.feishu || !isFeishuConnectBody(body)) return localRunnerUnavailable();
  const link = await resolveImConnectionLink(input, body, 'feishu', resolveWriteAgent);
  if (link instanceof Response) return link;
  const agentName = link
    ? link.agentName
    : await resolveWriteAgent(input.infra, readFeishuAgentName(body, 'mavis'), 'feishu');
  const compensate = link
    ? await captureConnectionBindingCompensation(input.feishu, link)
    : undefined;
  if (link) {
    await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'feishu' });
    logConnectionBindingState(link, 'start');
  }
  const bound = await input.feishu.bindBody({ ...body, agentName });
  if ('error' in bound) return link ? finishConnectionBinding(link, bound.error) : bound.error;
  if (link) {
    const persistenceError = await persistConnectionBinding(
      link,
      bound.record.clientId,
      compensate,
    );
    if (persistenceError) return persistenceError;
  } else {
    await bindAgentDefaultChannelBinding(
      input.infra,
      'feishu',
      bound.record.agentName,
      bound.record.clientId,
    );
  }
  return json({
    ok: true,
    connected: true,
    platform: 'feishu',
    clientId: bound.record.clientId,
    localRuntime: true,
    ...(link ? { connectionId: link.connectionId } : {}),
  });
}

async function disconnectChannel(input: BindRouteInput): Promise<Response> {
  const body = await readJsonBody(input.request);
  const platform = detectDisconnectPlatform(body);
  const agentName = resolveDisconnectAgentName(body);
  if (platform === 'telegram') {
    if (!input.telegram) return json({ ok: true, disconnected: false, localRuntime: true });
    await deleteAgentPlatformChannelBindings(input.infra, 'telegram', agentName);
    return input.telegram.unbind(disconnectRequestWithAgent(body, agentName));
  }
  if (platform === 'wechat') {
    if (!input.wechat) return json({ ok: true, disconnected: false, localRuntime: true });
    await deleteAgentPlatformChannelBindings(input.infra, 'wechat', agentName);
    return input.wechat.unbind(disconnectRequestWithAgent(body, agentName));
  }
  if (!input.feishu || !isFeishuDisconnectBody(body)) {
    return json({ ok: true, disconnected: false, localRuntime: true });
  }
  if (!isFeishuConnectBody(body) && !(await input.feishu.hasBindingBody(body))) {
    return json({ ok: true, disconnected: false, localRuntime: true });
  }
  await deleteAgentPlatformChannelBindings(input.infra, 'feishu', agentName);
  return input.feishu.unbindBody(body);
}

async function bindFeishu(input: BindRouteInput): Promise<Response> {
  if (!input.feishu) return localRunnerUnavailable();
  const body = await readJsonBody(input.request);
  const link = await resolveImConnectionLink(input, body, 'feishu', resolveWriteAgent);
  if (link instanceof Response) return link;
  const agentName = link
    ? link.agentName
    : await resolveWriteAgent(input.infra, readFeishuAgentName(body, 'mavis'), 'feishu');
  const compensate = link
    ? await captureConnectionBindingCompensation(input.feishu, link)
    : undefined;
  if (link) {
    await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'feishu' });
    logConnectionBindingState(link, 'start');
  }
  const response = await input.feishu.bind(
    requestWithJsonBody(input.request, { ...body, agentName }),
  );
  if (link) return finishConnectionBinding(link, response, compensate);
  if (response.ok)
    await bindAgentDefaultChannelBinding(input.infra, 'feishu', agentName, agentName);
  return response;
}

async function bindTelegram(input: BindRouteInput): Promise<Response> {
  if (!input.telegram) return localRunnerUnavailable();
  const body = await readJsonBody(input.request);
  const link = await resolveImConnectionLink(input, body, 'telegram', resolveWriteAgent);
  if (link instanceof Response) return link;
  const agentName = link
    ? link.agentName
    : await resolveWriteAgent(input.infra, readAgentName(body), 'telegram');
  const compensate = link
    ? await captureConnectionBindingCompensation(input.telegram, link)
    : undefined;
  if (link) {
    await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'telegram' });
    logConnectionBindingState(link, 'start');
  }
  const response = await input.telegram.bind(
    requestWithJsonBody(input.request, { ...body, agentName }),
  );
  if (link) return finishConnectionBinding(link, response, compensate);
  if (response.ok)
    await bindAgentDefaultChannelBinding(
      input.infra,
      'telegram',
      agentName,
      `telegram:${agentName}`,
    );
  return response;
}

async function unbindFeishu(input: BindRouteInput): Promise<Response> {
  if (!input.feishu) return localRunnerUnavailable();
  const requestForUnbind = input.request.clone();
  const body = await readJsonBody(input.request);
  await deleteAgentPlatformChannelBindings(
    input.infra,
    'feishu',
    readFeishuAgentName(body, 'mavis'),
  );
  return input.feishu.unbind(requestForUnbind);
}

async function bindWeChat(input: BindRouteInput, kind: 'bind' | 'start'): Promise<Response> {
  if (!input.wechat) return localRunnerUnavailable();
  const body = await readJsonBody(input.request);
  const link = await resolveImConnectionLink(input, body, 'wechat', resolveWriteAgent);
  if (link instanceof Response) return link;
  const agentName = link
    ? link.agentName
    : await resolveWriteAgent(input.infra, readAgentName(body), 'wechat');
  const compensate = link
    ? await captureConnectionBindingCompensation(input.wechat, link)
    : undefined;
  if (link) {
    await link.store.beginAuthorization({ connectionId: link.connectionId, channel: 'wechat' });
    logConnectionBindingState(link, 'start');
  }
  const requestForBind = requestWithJsonBody(input.request, { ...body, agentName });
  const response =
    kind === 'bind'
      ? await input.wechat.bind(requestForBind)
      : await input.wechat.startBind(requestForBind);
  if (link)
    return kind === 'bind'
      ? finishConnectionBinding(link, response, compensate)
      : finishWeChatStart(link, response, compensate);
  if (response.ok)
    await bindAgentDefaultChannelBinding(input.infra, 'wechat', agentName, `wechat:${agentName}`);
  return response;
}

async function unbindWeChat(input: BindRouteInput): Promise<Response> {
  if (!input.wechat) return localRunnerUnavailable();
  const requestForUnbind = input.request.clone();
  const body = await readJsonBody(input.request);
  await deleteAgentPlatformChannelBindings(input.infra, 'wechat', readAgentName(body));
  return input.wechat.unbind(requestForUnbind);
}

async function bindWeChatStatus(input: BindRouteInput): Promise<Response | undefined> {
  if (!input.wechat) return localRunnerUnavailable();
  const url = new URL(input.request.url);
  const sessionId = url.searchParams.get('sessionId') ?? url.searchParams.get('session_id');
  const connectionId =
    url.searchParams.get('connectionId') ??
    url.searchParams.get('connection_id') ??
    (sessionId
      ? input.infra.imConnectionStore?.findAuthorizationByPlatformSession('wechat', sessionId)
      : undefined);
  if (!connectionId) return undefined;
  const link = await resolveImConnectionId(
    input,
    connectionId,
    'wechat',
    undefined,
    resolveWriteAgent,
  );
  if (link instanceof Response) return link;
  const compensate = await captureConnectionBindingCompensation(input.wechat, link);
  const response = await input.wechat.bindStatus(url);
  const payload = await readResponsePayload(response);
  const status = readFirstString(payload ?? {}, ['status'])?.toLowerCase();
  if (responseSucceeded(response, payload) && status === 'confirmed') {
    return finishConnectionBinding(link, response, compensate);
  }
  if (status === 'expired') {
    await link.store.expireAuthorization(link.connectionId);
    logConnectionBindingState(link, 'expired', {
      status: response.status,
      code: responseCode(payload, 'WECHAT_BIND_EXPIRED'),
    });
  } else if (!responseSucceeded(response, payload) || status === 'error') {
    const code = responseCode(payload, 'WECHAT_BIND_STATUS_FAILED');
    await link.store.markAuthorizationError(link.connectionId, 'wechat', code);
    logConnectionBindingState(link, 'failed', { status: response.status, code });
  } else if (sessionId) {
    await link.store.beginAuthorization({
      connectionId: link.connectionId,
      channel: 'wechat',
      platformSessionId: sessionId,
    });
  }
  return responseWithConnectionId(response, payload, link.connectionId);
}

function readAgentName(body: Record<string, unknown>): string {
  return readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ?? 'mavis';
}

async function resolveWriteAgent(
  infra: LocalChannelBridgeInfra,
  requestedName: string,
  platform: ChannelPlatform,
): Promise<string> {
  if (!infra.resolveAgentWriteTarget) {
    throw new LocalAgentContractError(
      503,
      'Agent write resolver is unavailable',
      'AGENT_RESOLVER_UNAVAILABLE',
    );
  }
  try {
    return await infra.resolveAgentWriteTarget(requestedName);
  } catch (err) {
    if (err instanceof LocalAgentContractError && err.code === 'UNKNOWN_AGENT_NAME') {
      return validateAgentName(requestedName);
    }
    const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
      platform,
      canonicalAgentName: 'mavis',
      agentNames: ['mavis', 'main'],
    });
    if (primaryConflict) throw primaryConflict;
    throw err;
  }
}

function requestWithJsonBody(input: Request, body: Record<string, unknown>): Request {
  const headers = new Headers(input.headers);
  headers.set('content-type', 'application/json');
  return new Request(input.url, { method: input.method, headers, body: JSON.stringify(body) });
}

function resolveDisconnectAgentName(body: Record<string, unknown>): string {
  const explicit = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']);
  if (explicit) return explicit;
  const raw = readFirstString(body, ['name', 'clientId', 'client_id']);
  if (!raw) return 'mavis';
  const stripped = stripPlatformPrefix(raw).trim();
  return !stripped || isPlatformLiteral(stripped) ? 'mavis' : stripped;
}

function stripPlatformPrefix(value: string): string {
  const lower = value.toLowerCase();
  for (const prefix of ['telegram:', 'wechat:', 'feishu:']) {
    if (lower.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

function isPlatformLiteral(value: string): boolean {
  return ['feishu', 'lark', 'telegram', 'wechat'].includes(value.toLowerCase());
}

function disconnectRequestWithAgent(body: Record<string, unknown>, agentName: string): Request {
  return new Request('http://local/channel-bridge/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, agentName }),
  });
}

function detectDisconnectPlatform(body: Record<string, unknown>): 'feishu' | 'telegram' | 'wechat' {
  const explicit = readFirstString(body, ['platform']);
  if (explicit === 'telegram' || explicit === 'wechat' || explicit === 'feishu') return explicit;
  const name = readFirstString(body, ['name', 'clientId', 'client_id']) ?? '';
  if (name.startsWith('telegram:')) return 'telegram';
  if (name.startsWith('wechat:')) return 'wechat';
  return 'feishu';
}

function isNonFeishuPlatformBody(body: Record<string, unknown>): boolean {
  const platform = readFirstString(body, ['platform']);
  if (platform === 'telegram' || platform === 'wechat') return true;
  const name = readFirstString(body, ['name', 'clientId', 'client_id']);
  return name?.startsWith('telegram:') === true || name?.startsWith('wechat:') === true;
}

function isFeishuConnectBody(body: Record<string, unknown>): boolean {
  if (isNonFeishuPlatformBody(body)) return false;
  const name = readFirstString(body, ['name', 'platform', 'clientId', 'client_id']);
  return name === 'feishu' || name?.startsWith('feishu:') === true || hasFeishuCredentials(body);
}

function isFeishuDisconnectBody(body: Record<string, unknown>): boolean {
  if (isNonFeishuPlatformBody(body)) return false;
  if (isFeishuConnectBody(body)) return true;
  const name = readFirstString(body, ['name']);
  return Boolean(name) && !readFirstString(body, ['botToken', 'token']);
}

function hasFeishuCredentials(body: Record<string, unknown>): boolean {
  return Boolean(
    readFirstString(body, ['appId', 'app_id']) &&
    readFirstString(body, ['appSecret', 'app_secret']),
  );
}

function localRunnerUnavailable(): Response {
  return json(
    {
      ok: false,
      error: 'Local channel platform runner is not implemented in G6 channel infra.',
      code: 'LOCAL_CHANNEL_RUNNER_UNAVAILABLE',
      localRuntime: true,
    },
    { status: 200 },
  );
}
