/**
 * Telegram adapter route helper — drives the `/channel-bridge/telegram/*`
 * endpoints (bind / unbind / status / inbound) through the
 * {@link LocalChannelAdapterRegistry}.
 *
 * Lives in its own file so {@link telegram-adapter.ts} stays under the
 * default 500-line source budget. Both files are tightly coupled (the routes
 * only know how to talk to a `TelegramPlatformAdapter`), but split keeps the
 * adapter class self-contained and the route surface easy to evolve.
 *
 * The dispatcher returns `undefined` when the path does not match one of
 * the adapter-routed endpoints. The caller (the infra route handler) then
 * falls through to its own legacy webhook branch and the routes still wired against
 * `LocalTelegramChannelApi` keep working unchanged.
 */

import { json, readFirstString, readJsonBody } from '../../../api/http-helpers.js';
import { LocalAgentContractError, validateAgentName } from '../../../agent/contract.js';
import { normalizePrimaryAgentResolutionConflict } from '../../../api/host-channel-family-gate.js';
import { imLogger as logger } from '../../../common/im-logger.js';

import type { LocalChannelAdapterRegistry } from '../../adapter-registry.js';
import type { LocalChannelPlatformAdapter } from '../../adapter.js';
import type { ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalChannelContext } from '../../infra.js';
import type { ChannelPlatform } from '../../route-api.js';
import { telegramClientId } from '../../telegram.js';
import {
  downloadAttachmentsForUnifiedInbound,
  ensureUnifiedInboundText,
} from './telegram-adapter-shared.js';

export interface TelegramAdapterRouteDispatcher {
  /** When provided, the inbound path forwards the normalised envelope here. */
  dispatchInbound?: (input: {
    ctx: LocalChannelContext;
    text: string;
    eventId?: string;
    attachments?: import('../../../messages/input.js').LocalMessageAttachment[];
  }) => Promise<unknown>;
  bindDefaultBinding?: (
    platform: ChannelPlatform,
    agentName: string,
    clientName: string,
  ) => Promise<unknown>;
  deletePlatformBindings?: (platform: ChannelPlatform, agentName: string) => Promise<unknown>;
  /**
   * Register (and return) the adapter for `agentName` when the registry has no
   * entry yet. Wired to the per-agent adapter factory so `bind` can self-heal a
   * cold registry instead of returning `ADAPTER_UNAVAILABLE` — without it, an
   * agent that never bound successfully can never register, and can never bind.
   */
  ensureAdapter?: (agentName: string) => LocalChannelPlatformAdapter | undefined;
  /** Default agent name when the request body omits one. Defaults to `mavis`. */
  defaultAgentName?: string;
  /** Shared write-target seam for the external bind request. */
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
}

const ADAPTER_UNAVAILABLE = {
  status: 503,
  body: { ok: false, error: 'telegram adapter not registered', code: 'ADAPTER_UNAVAILABLE' },
} as const;

/**
 * Dispatch a registry-backed `/channel-bridge/telegram/*` request. Returns
 * `undefined` for paths that are not handled here.
 *
 * Endpoints (all under `/channel-bridge/telegram/`):
 *   - `POST  bind`     → registry.adapter.bind()
 *   - `POST  unbind`   → registry.adapter.unbind()
 *   - `GET   status`   → registry.adapter.status()
 *   - `POST  inbound`  → adapter.normalizeInbound() → dispatcher (when wired)
 */
export async function dispatchTelegramAdapterRoute(input: {
  method: string;
  path: string;
  request: Request;
  registry: LocalChannelAdapterRegistry;
  dispatcher?: TelegramAdapterRouteDispatcher;
}): Promise<Response | undefined> {
  const { method, path, request, registry, dispatcher } = input;
  const defaultAgentName = dispatcher?.defaultAgentName ?? 'mavis';

  if (method === 'POST' && path === 'telegram/bind') {
    const body = await readJsonBody(request);
    const requestedMode = readFirstString(body, ['mode'])?.toLowerCase();
    if (requestedMode === 'mock') {
      return json(
        {
          ok: false,
          error: 'mock channel mode is not supported',
          code: 'CHANNEL_MOCK_MODE_UNSUPPORTED',
          platform: 'telegram',
          localRuntime: true,
        },
        { status: 400 },
      );
    }
    if (requestedMode && requestedMode !== 'sdk') {
      return json(
        {
          ok: false,
          error: 'unsupported channel mode',
          code: 'VALIDATION_ERROR',
          platform: 'telegram',
          localRuntime: true,
        },
        { status: 400 },
      );
    }
    const requestedName =
      readFirstString(body, ['agentName', 'agentId', 'agent']) ?? defaultAgentName;
    if (!dispatcher?.resolveAgentWriteTarget) {
      throw new LocalAgentContractError(
        503,
        'Agent write resolver is unavailable',
        'AGENT_RESOLVER_UNAVAILABLE',
      );
    }
    let agentName: string;
    try {
      agentName = await dispatcher.resolveAgentWriteTarget(requestedName);
    } catch (err) {
      // First-bind channel provisioning may precede creation of a custom Agent
      // row; keep the permissive fallback at this concrete ingress only.
      if (err instanceof LocalAgentContractError && err.code === 'UNKNOWN_AGENT_NAME') {
        agentName = validateAgentName(requestedName);
      } else {
        const primaryConflict = normalizePrimaryAgentResolutionConflict(err, {
          platform: 'telegram',
          canonicalAgentName: 'mavis',
          agentNames: ['mavis', 'main'],
        });
        if (primaryConflict) throw primaryConflict;
        throw err;
      }
    }
    const clientName = telegramClientId(agentName);
    // Self-heal a cold registry: the very first bind for an agent runs before
    // any adapter is registered (registration otherwise only happens for the
    // default agent at startup, or during restore of an already-bound agent).
    // Reading without creating here would 503 forever, since a successful bind
    // is the only thing that would ever register the adapter.
    const cached = registry.get('telegram', clientName);
    const adapter = cached ?? dispatcher?.ensureAdapter?.(agentName);
    // Trace how the bind resolved its adapter so a production 503 — or a
    // partial recovery where some agents bind and others still 503 — is
    // diagnosable from logs alone. `source` distinguishes a warm registry hit
    // from a first-bind self-heal from an unrecoverable miss; `registeredCount`
    // shows how many telegram adapters the registry currently holds. This runs
    // BEFORE `adapter.bind`, so it also proves the request reached the bind
    // handler at all. No token / credential material is read here.
    logger.info(
      {
        agentName,
        clientName,
        source: cached ? 'registry' : adapter ? 'ensured' : 'missing',
        registeredCount: registry.list('telegram').length,
      },
      'Telegram bind resolving adapter',
    );
    if (!adapter) {
      logger.warn(
        {
          agentName,
          clientName,
          canEnsure: Boolean(dispatcher?.ensureAdapter),
          registered: registry.list('telegram').map((entry) => entry.clientName),
        },
        'Telegram bind rejected: adapter unavailable and could not be created',
      );
      return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
    }
    const result = await adapter.bind({ agentName, credentials: body });
    if (result.ok) await dispatcher?.bindDefaultBinding?.('telegram', agentName, result.clientName);
    // Hydrate the legacy `LocalTelegramChannelApi.bind` response shape so
    // callers (UI / tests) keep seeing `connected`, `hasCredentials`,
    // `tokenMasked`, and `botName`. The adapter's `status()` reads from the
    // same store the bind just wrote, so this is a single source of truth.
    const status = result.ok ? await adapter.status({ agentName }) : undefined;
    const detail = (status?.detail as Record<string, unknown> | undefined) ?? {};
    return json(
      {
        ...result,
        platform: 'telegram',
        clientId: result.clientName,
        ...(result.ok
          ? {
              connected: status?.connected === true,
              hasCredentials: status?.configured === true,
              ...(typeof detail.tokenMasked === 'string'
                ? { tokenMasked: detail.tokenMasked }
                : {}),
              ...(typeof detail.botName === 'string' ? { botName: detail.botName } : {}),
            }
          : {}),
        localRuntime: true,
      },
      { status: result.ok ? 200 : 400 },
    );
  }

  if (method === 'POST' && path === 'telegram/unbind') {
    const body = await readJsonBody(request);
    const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? defaultAgentName;
    const adapter = registry.get('telegram', telegramClientId(agentName));
    if (!adapter) return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
    const result = await adapter.unbind({ agentName });
    if (result.ok) await dispatcher?.deletePlatformBindings?.('telegram', agentName);
    return json({
      ok: true,
      unbound: result.ok,
      platform: 'telegram',
      clientId: telegramClientId(agentName),
      localRuntime: true,
    });
  }

  if (method === 'GET' && path === 'telegram/status') {
    const url = new URL(request.url);
    const agentName = url.searchParams.get('agent') ?? defaultAgentName;
    const adapter = registry.get('telegram', telegramClientId(agentName));
    if (!adapter) return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
    const result = await adapter.status({ agentName });
    return json({
      ok: true,
      platform: 'telegram',
      clientId: result.clientName,
      configured: result.configured,
      connected: result.connected,
      ...(result.detail ? { detail: result.detail } : {}),
      localRuntime: true,
    });
  }

  if (method === 'POST' && path === 'telegram/inbound') {
    const body = await readJsonBody(request);
    const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? defaultAgentName;
    const adapter = registry.get('telegram', telegramClientId(agentName));
    if (!adapter) return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
    let envelope: ChannelInboundEnvelope;
    try {
      envelope = await adapter.normalizeInbound({
        clientName: adapter.clientName,
        raw: body,
      });
    } catch (err) {
      return json(
        {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'INVALID_PAYLOAD',
        },
        { status: 400 },
      );
    }
    if (dispatcher?.dispatchInbound) {
      // Multimodal inbound: resolve attachmentRefs to local files via the
      // adapter's downloadAttachmentToLocal. Failures degrade gracefully —
      // each failed ref becomes a `download_failed` placeholder and the
      // rest of the batch is dispatched unchanged.
      const attachments = await downloadAttachmentsForUnifiedInbound(adapter, envelope);
      const dispatched = await dispatcher.dispatchInbound({
        ctx: envelope.ctx,
        text: ensureUnifiedInboundText(envelope.text, envelope.attachmentRefs),
        ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return json({ ok: true, envelope, dispatched, localRuntime: true });
    }
    return json({ ok: true, envelope, localRuntime: true });
  }

  return undefined;
}
