import { json, notFound, readFirstString, readJsonBody } from '../api/http-helpers.js';
import { LocalAgentContractError } from '../agent/contract.js';
import type { LocalAccessControlStore } from './access-control-store.js';
import {
  captureConnectionBindingCompensation,
  logConnectionBindingState,
  type ImConnectionLink,
} from './channel-connection-binding.js';
import type { LocalFeishuChannelApi } from './feishu.js';
import type { LocalChannelBindingStore } from './infra.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import { LocalFeishuOnboardHttpClient, type FeishuFetch } from './feishu-onboard-http.js';
import {
  LocalImConnectionError,
  type LocalImConnection,
  type LocalImConnectionStore,
} from './im-connection-store.js';
import { serialize, type FeishuOnboardSession } from './feishu-onboard-helpers.js';

interface FeishuOnboardOptions {
  feishu: LocalFeishuChannelApi;
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  bindingStore?: LocalChannelBindingStore;
  /** V2 Connection lifecycle owner; absent for legacy onboarding compatibility. */
  imConnectionStore?: LocalImConnectionStore;
  accessControlStore?: LocalAccessControlStore;
  bindRootlessDefaultSession?: (agentName: string) => Promise<void>;
  ensureRootSession?: (agentName: string) => Promise<{ sessionId?: string } | undefined>;
  nowMs: () => number;
  makeId: (prefix: string) => string;
  fetchImpl?: FeishuFetch;
  accountsBaseUrl?: string;
  openApiBaseUrl?: string;
  /** Optional metrics reporter injected by the host. Absent → noop. */
  metrics?: ModuleMetricsReporter;
}

const FINISHED_TTL_MS = 5 * 60_000;

export class LocalFeishuOnboardService {
  private readonly sessions = new Map<string, FeishuOnboardSession>();
  private readonly feishu: LocalFeishuChannelApi;
  private readonly resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  private readonly bindingStore?: LocalChannelBindingStore;
  private readonly imConnectionStore?: LocalImConnectionStore;
  private readonly accessControlStore?: LocalAccessControlStore;
  private readonly bindRootlessDefaultSession?: (agentName: string) => Promise<void>;
  private readonly ensureRootSession?: (
    agentName: string,
  ) => Promise<{ sessionId?: string } | undefined>;
  private readonly nowMs: () => number;
  private readonly makeId: (prefix: string) => string;
  private readonly onboardingHttp: LocalFeishuOnboardHttpClient;
  private readonly metrics?: ModuleMetricsReporter;

  constructor(options: FeishuOnboardOptions) {
    this.feishu = options.feishu;
    this.resolveAgentWriteTarget = options.resolveAgentWriteTarget;
    this.bindingStore = options.bindingStore;
    this.imConnectionStore = options.imConnectionStore;
    this.accessControlStore = options.accessControlStore;
    this.bindRootlessDefaultSession = options.bindRootlessDefaultSession;
    this.ensureRootSession = options.ensureRootSession;
    this.nowMs = options.nowMs;
    this.makeId = options.makeId;
    this.metrics = options.metrics;
    this.onboardingHttp = new LocalFeishuOnboardHttpClient(options);
  }

  async route(request: Request, method: string, parts: string[], url: URL): Promise<Response> {
    if (parts[0] !== 'lark' || parts[1] !== 'onboard') return notFound(`/${parts.join('/')}`);
    const action = parts[2];
    if (method === 'POST' && action === 'start') {
      try {
        return await this.start(request);
      } catch (err) {
        if (err instanceof LocalAgentContractError || err instanceof LocalImConnectionError) {
          return json(
            { ok: false, error: err.message, code: err.code, localRuntime: true },
            { status: err.status },
          );
        }
        throw err;
      }
    }
    if (method === 'GET' && action === 'status') return this.status(url);
    if (method === 'POST' && action === 'cancel') return this.cancel(request);
    return notFound(`/lark/onboard/${action ?? ''}`);
  }

  private async start(request: Request): Promise<Response> {
    await this.sweep();
    const body = await readJsonBody(request);
    const connectionId = readFirstString(body, ['connectionId', 'connection_id']);
    const explicitRequestedName = readFirstString(body, ['agentName', 'agent_name']);
    const requestedName = explicitRequestedName ?? 'mavis';
    if (!connectionId && !this.resolveAgentWriteTarget) {
      throw new LocalAgentContractError(
        503,
        'Agent write resolver is unavailable',
        'AGENT_RESOLVER_UNAVAILABLE',
      );
    }
    const connection = connectionId
      ? await this.requireConnection(connectionId, explicitRequestedName)
      : undefined;
    let agentName: string;
    if (connection) {
      agentName = connection.agentName;
    } else {
      const resolveAgentWriteTarget = this.resolveAgentWriteTarget;
      if (!resolveAgentWriteTarget) {
        throw new LocalAgentContractError(
          503,
          'Agent write resolver is unavailable',
          'AGENT_RESOLVER_UNAVAILABLE',
        );
      }
      agentName = await resolveAgentWriteTarget(requestedName);
    }
    const connectionLink: ImConnectionLink | undefined =
      connection && this.imConnectionStore
        ? {
            connectionId: connection.connectionId,
            channel: 'feishu',
            agentName,
            store: this.imConnectionStore,
          }
        : undefined;
    const sessionId = this.makeId('lark_onboard');
    const skipUserAuth = body.skipUserAuth === true;
    if (connectionLink) {
      await connectionLink.store.beginAuthorization({
        connectionId: connectionLink.connectionId,
        channel: 'feishu',
        platformSessionId: sessionId,
      });
      logConnectionBindingState(connectionLink, 'start');
    }
    const started = await this.onboardingHttp.beginAppRegistration();
    if (!started.ok) {
      const now = this.nowMs();
      const session: FeishuOnboardSession = {
        sessionId,
        agentName,
        status: 'error',
        expiresAtMs: now,
        intervalSec: 5,
        skipUserAuth,
        error: 'FEISHU_ONBOARD_START_FAILED',
        ...(connection ? { connectionId: connection.connectionId } : {}),
      };
      this.sessions.set(sessionId, session);
      if (connectionLink) {
        await connectionLink.store.markAuthorizationError(
          connectionLink.connectionId,
          'feishu',
          'FEISHU_ONBOARD_START_FAILED',
        );
        logConnectionBindingState(connectionLink, 'failed', {
          status: 502,
          code: 'FEISHU_ONBOARD_START_FAILED',
        });
      }
      this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'error' });
      return json({ ok: false, ...serialize(session, now) }, { status: 502 });
    }
    const now = this.nowMs();
    const session: FeishuOnboardSession = {
      sessionId,
      agentName,
      status: 'app_pending',
      appDeviceCode: started.deviceCode,
      verificationUriComplete: started.verificationUriComplete,
      userCode: started.userCode,
      expiresAtMs: now + started.expiresInSec * 1000,
      intervalSec: started.intervalSec,
      skipUserAuth,
      ...(connection ? { connectionId: connection.connectionId } : {}),
    };
    this.sessions.set(sessionId, session);
    if (connectionLink) {
      await connectionLink.store.beginAuthorization({
        connectionId: connectionLink.connectionId,
        channel: 'feishu',
        platformSessionId: sessionId,
        expiresAt: session.expiresAtMs,
      });
      logConnectionBindingState(connectionLink, 'pending');
    }
    return json({ ok: true, ...serialize(session, now) });
  }

  private async status(url: URL): Promise<Response> {
    await this.sweep();
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = this.sessions.get(sessionId);
    if (!session)
      return json({ ok: false, status: 'error', error: 'session not found' }, { status: 404 });
    await this.advance(session);
    await this.syncConnectionAuthorization(session);
    return json({ ok: session.status !== 'error', ...serialize(session, this.nowMs()) });
  }

  private async cancel(request: Request): Promise<Response> {
    const body = await readJsonBody(request);
    const sessionId = readFirstString(body, ['sessionId', 'session_id']);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const cancelled = sessionId ? this.sessions.delete(sessionId) : false;
    if (session?.connectionId)
      await this.imConnectionStore?.cancelAuthorization(session.connectionId);
    return json({ ok: true, cancelled });
  }

  /** Called by the Connection-level cancel endpoint; legacy Lark cancel stays intact. */
  async cancelAuthorizationForConnection(connectionId: string): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (session.connectionId === connectionId) this.sessions.delete(sessionId);
    }
  }

  private async advance(session: FeishuOnboardSession): Promise<void> {
    if (session.status === 'done' || session.status === 'error') return;
    if (this.isExpired(session)) {
      this.markExpired(session);
      return;
    }
    if (session.status === 'app_pending') {
      await this.advanceApp(session);
      return;
    }
    if (session.status === 'user_pending') await this.advanceUser(session);
  }

  private async advanceApp(session: FeishuOnboardSession): Promise<void> {
    if (!session.appDeviceCode) {
      this.markError(session, 'FEISHU_ONBOARD_FAILED');
      return;
    }
    const poll = await this.onboardingHttp.pollAppRegistration(session.appDeviceCode);
    if (!poll.ok) {
      if (this.isExpired(session, poll.error)) this.markExpired(session);
      else this.markError(session, 'FEISHU_ONBOARD_FAILED');
      return;
    }
    if (poll.pending) return;
    session.appId = poll.appId;
    session.appSecret = poll.appSecret;
    const connectionLink = this.connectionLink(session);
    let compensate: ((clientName: string) => Promise<void>) | undefined;
    if (connectionLink) {
      try {
        compensate = await captureConnectionBindingCompensation(this.feishu, connectionLink);
      } catch (error) {
        this.markError(
          session,
          error instanceof LocalImConnectionError
            ? error.code
            : 'FEISHU_ONBOARD_COMPENSATION_UNAVAILABLE',
        );
        return;
      }
    }
    const bound = await this.bindBot(session);
    if (!bound.ok) {
      this.markError(session, 'FEISHU_ONBOARD_FAILED');
      return;
    }
    session.clientName = bound.clientName;
    try {
      await this.bindDefaultSession(session);
    } catch (error) {
      if (compensate) {
        try {
          await compensate(bound.clientName);
        } catch (compensationError) {
          this.markError(
            session,
            compensationError instanceof LocalImConnectionError
              ? compensationError.code
              : 'CHANNEL_PLATFORM_COMPENSATION_FAILED',
          );
          return;
        }
      }
      this.markError(
        session,
        error instanceof LocalImConnectionError ? error.code : 'FEISHU_ONBOARD_BIND_FAILED',
      );
      return;
    }
    if (connectionLink) logConnectionBindingState(connectionLink, 'bound');
    session.botBound = true;
    if (session.skipUserAuth) {
      this.finish(session);
      return;
    }
    const user = await this.onboardingHttp.beginUserDeviceCode(session.appId);
    if (!user.ok) {
      this.markError(session, 'FEISHU_ONBOARD_FAILED');
      return;
    }
    const now = this.nowMs();
    session.status = 'user_pending';
    session.userDeviceCode = user.deviceCode;
    session.userVerificationUriComplete = user.verificationUriComplete;
    session.userCodeFromCli = user.userCode;
    session.userExpiresAtMs = now + user.expiresInSec * 1000;
    session.userIntervalSec = user.intervalSec;
  }

  private async advanceUser(session: FeishuOnboardSession): Promise<void> {
    if (!session.appId || !session.appSecret || !session.userDeviceCode) {
      this.markError(session, 'FEISHU_ONBOARD_FAILED');
      return;
    }
    const poll = await this.onboardingHttp.pollUserToken(session);
    if (!poll.ok) {
      if (this.isExpired(session, poll.error)) this.markExpired(session);
      else this.markError(session, 'FEISHU_ONBOARD_FAILED');
      return;
    }
    if (poll.pending) return;
    session.userOpenId = poll.openId;
    session.userName = poll.name;
    this.finish(session);
  }

  private finish(session: FeishuOnboardSession): void {
    session.status = 'done';
    session.confirmedAtMs = this.nowMs();
    // Terminal transition; advance() early-returns on 'done', so exactly once.
    this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'done' });
  }

  /** Terminal error transition — stable codes keep provider details out of status responses. */
  private markError(session: FeishuOnboardSession, error: string): void {
    const wasError = session.status === 'error';
    session.status = 'error';
    session.error = error;
    this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'error' });
    const connectionLink = this.connectionLink(session);
    if (!wasError && connectionLink) {
      logConnectionBindingState(connectionLink, 'failed', {
        status: 502,
        code: 'FEISHU_ONBOARD_FAILED',
      });
    }
  }

  private markExpired(session: FeishuOnboardSession): void {
    const wasError = session.status === 'error';
    session.status = 'error';
    session.error = 'authorization expired';
    this.metrics?.incr('channel_onboard_total', { channel: 'feishu', status: 'error' });
    session.expired = true;
    const connectionLink = this.connectionLink(session);
    if (!wasError && connectionLink) {
      logConnectionBindingState(connectionLink, 'expired', { code: 'FEISHU_ONBOARD_EXPIRED' });
    }
  }

  private isExpired(session: FeishuOnboardSession, providerError?: string): boolean {
    const expiresAtMs =
      session.status === 'user_pending' ? session.userExpiresAtMs : session.expiresAtMs;
    const providerExpired = providerError?.toLowerCase().includes('expired') === true;
    return providerExpired || (expiresAtMs !== undefined && this.nowMs() >= expiresAtMs);
  }

  private async bindBot(
    session: FeishuOnboardSession,
  ): Promise<{ ok: true; clientName: string } | { ok: false }> {
    const result = await this.feishu.bindBody({
      agentName: session.agentName,
      appId: session.appId,
      appSecret: session.appSecret,
      botName: 'Mavis Feishu Bot',
      mode: 'websocket',
    });
    if ('error' in result) {
      return { ok: false };
    }
    return { ok: true, clientName: result.record.clientId };
  }

  private async bindDefaultSession(session: FeishuOnboardSession): Promise<void> {
    if (session.connectionId && this.imConnectionStore) {
      if (!session.clientName) {
        throw new LocalImConnectionError(
          502,
          'FEISHU_CLIENT_ID_MISSING',
          'Feishu onboarding did not return a transport client identity.',
        );
      }
      await this.imConnectionStore.bind({
        connectionId: session.connectionId,
        clientName: session.clientName,
      });
      return;
    }
    if (this.bindRootlessDefaultSession) {
      await this.bindRootlessDefaultSession(session.agentName);
      return;
    }
    if (!this.bindingStore || !this.ensureRootSession) return;
    const root = await this.ensureRootSession(session.agentName);
    if (!root?.sessionId) return;
    await this.bindingStore.upsert(
      {
        platform: 'feishu',
        chatType: 'agent',
        chatId: session.agentName,
        senderId: session.agentName,
        clientName: session.agentName,
        lane: 'interactive',
      },
      { agentName: session.agentName, sessionId: root.sessionId, strategy: 'root', pinned: false },
    );
    await this.accessControlStore?.ensureDefaultPolicy('feishu', session.agentName);
  }

  private connectionLink(session: FeishuOnboardSession): ImConnectionLink | undefined {
    if (!session.connectionId || !this.imConnectionStore) return undefined;
    return {
      connectionId: session.connectionId,
      channel: 'feishu',
      agentName: session.agentName,
      store: this.imConnectionStore,
    };
  }

  private async requireConnection(
    connectionId: string,
    requestedAgentName?: string,
  ): Promise<LocalImConnection> {
    if (!this.imConnectionStore) {
      throw new LocalImConnectionError(
        503,
        'CHANNEL_CONNECTIONS_UNAVAILABLE',
        'Channel Connections require the Local Runtime V2 Conversation composition.',
      );
    }
    const connection = await this.imConnectionStore.getConnection(connectionId);
    if (!connection) {
      throw new LocalImConnectionError(
        404,
        'CHANNEL_CONNECTION_NOT_FOUND',
        'Channel Connection not found.',
      );
    }
    if (connection.channel !== 'feishu') {
      throw new LocalImConnectionError(
        409,
        'CHANNEL_CONNECTION_CHANNEL_MISMATCH',
        'Channel mismatch.',
      );
    }
    if (requestedAgentName) {
      const resolved = this.resolveAgentWriteTarget
        ? await this.resolveAgentWriteTarget(requestedAgentName)
        : requestedAgentName;
      if (resolved !== connection.agentName) {
        throw new LocalImConnectionError(
          409,
          'CHANNEL_CONNECTION_AGENT_MISMATCH',
          'The requested Agent does not match this Channel Connection.',
        );
      }
    }
    return connection;
  }

  private async syncConnectionAuthorization(session: FeishuOnboardSession): Promise<void> {
    if (!session.connectionId || !this.imConnectionStore || session.botBound) return;
    if (session.status !== 'error') return;
    if (session.expired) {
      await this.imConnectionStore.expireAuthorization(session.connectionId);
      return;
    }
    await this.imConnectionStore.markAuthorizationError(
      session.connectionId,
      'feishu',
      'FEISHU_ONBOARD_FAILED',
    );
  }

  private async sweep(): Promise<void> {
    const now = this.nowMs();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.confirmedAtMs && now - session.confirmedAtMs > FINISHED_TTL_MS) {
        this.sessions.delete(sessionId);
        continue;
      }
      if (session.status !== 'done' && session.status !== 'error' && this.isExpired(session)) {
        this.markExpired(session);
        await this.syncConnectionAuthorization(session);
      }
    }
  }
}
