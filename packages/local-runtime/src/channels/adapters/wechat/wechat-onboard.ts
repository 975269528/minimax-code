/**
 * WeChat iLink real onboarding flow.
 *
 * Implements two stages:
 *   1. `startBindReal` — POST a fresh QR via iLink `get_bot_qrcode` (no auth)
 *      and persist a `pending` bind session in {@link LocalWeChatChannelStore}.
 *   2. `pollBindStatusReal` — one-shot long-poll iLink `get_qrcode_status`;
 *      on `confirmed`, finalize the binding with the issued `bot_token` /
 *      `ilink_bot_id`.
 *
 * HTTP transport is `globalThis.fetch` so we stay portable across Node + test
 * runners; production (Electron main) shares the same call surface. Tests
 * stub `globalThis.fetch` to drive deterministic transitions. The SDK's
 * `ILinkAuth` (which uses Electron's `net.fetch`) is NOT imported here so
 * we do not drag the `electron` runtime into the onboard surface.
 */

import type { LocalWeChatBindingRecord, LocalWeChatChannelStore } from '../../wechat.js';
import { buildIlinkCommonHeaders } from './sdk/ilink-wire.js';

export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_BOT_TYPE = '3';

/** Raw QR response shape — mirrors `wechat-sdk/ilink-types.QRCodeResponse`. */
interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/** Status long-poll response — mirrors `wechat-sdk/ilink-types.StatusResponse`. */
interface StatusResponse {
  status?:
    | 'wait'
    | 'scaned'
    | 'confirmed'
    | 'expired'
    | 'scaned_but_redirect'
    | 'need_verifycode'
    | 'verify_code_blocked'
    | 'binded_redirect';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
  errcode?: number;
  errmsg?: string;
}

export interface WeChatStartBindRealInput {
  agentName: string;
  sessionId: string;
  baseUrl?: string;
  botType?: string;
}

export interface WeChatStartBindRealResult {
  status: 'pending';
  sessionId: string;
  qrcode: string;
  qrcodeUrl: string;
  isImageData: boolean;
  /**
   * Set when {@link startBindReal} short-circuited because a `connected`
   * binding already exists. The caller (route) surfaces this so the UI can
   * jump straight to the bound state instead of rendering a QR that would
   * never confirm.
   */
  alreadyBound?: boolean;
}

export interface WeChatPollBindStatusInput {
  sessionId: string;
  agentName: string;
  baseUrl?: string;
}

export type WeChatPollBindStatusResult =
  | { status: 'pending'; sessionId: string; qrcodeUrl?: string }
  | { status: 'scanned'; sessionId: string; qrcodeUrl?: string }
  | {
      status: 'confirmed';
      sessionId: string;
      clientId: string;
      botToken: string;
      ilinkBotId: string;
      baseUrl?: string;
    }
  | { status: 'expired'; sessionId: string; error: string }
  | { status: 'error'; sessionId: string; error: string };

/** Minimal fetcher signature — tests inject a stub. */
export type WeChatFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Call iLink `/ilink/bot/get_bot_qrcode` and persist a `pending` binding.
 * Returns the QR url for the UI to render.
 */
export async function startBindReal(
  input: WeChatStartBindRealInput,
  store: LocalWeChatChannelStore,
  options: { fetch?: WeChatFetch } = {},
): Promise<WeChatStartBindRealResult> {
  // Overwrite guard: the UI auto-fires startBind on mount (incl. when the user
  // merely re-opens the bind dialog to inspect an already-bound channel). The
  // legacy behaviour blindly persisted a fresh `pending:` record under the same
  // `wechat:<agent>` clientId key, clobbering a previously `confirmed`
  // (`connected: true`) binding back to disconnected. That is what made a
  // successful scan "disappear" on the next visit. Only an active real polling
  // binding can short-circuit; a disabled rollback row must get a fresh QR
  // instead of being reported as confirmed.
  const existing = await store.get(input.agentName);
  if (
    existing?.enabled === true &&
    existing.connected === true &&
    existing.mode === 'polling' &&
    existing.botToken &&
    !existing.botToken.startsWith('pending:')
  ) {
    return {
      status: 'pending',
      sessionId: existing.bindSessionId ?? input.sessionId,
      qrcode: existing.qrcodeToken ?? '',
      qrcodeUrl: existing.qrcodeUrl ?? '',
      isImageData: false,
      alreadyBound: true,
    };
  }
  const baseUrl = ensureTrailingSlash(input.baseUrl ?? DEFAULT_ILINK_BASE_URL);
  const botType = encodeURIComponent(input.botType ?? DEFAULT_BOT_TYPE);
  const url = `${baseUrl}ilink/bot/get_bot_qrcode?bot_type=${botType}`;
  const doFetch = options.fetch ?? globalFetch();
  const res = await doFetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`iLink getQrCode failed: ${res.status} ${res.statusText} body=${body}`);
  }
  const data = (await res.json()) as QrCodeResponse;
  const { qrcodeUrl, isImageData } = normaliseQrContent(data.qrcode_img_content);

  await store.bind({
    agentName: input.agentName,
    botToken: `pending:${input.sessionId}`,
    bindSessionId: input.sessionId,
    qrcodeUrl,
    qrcodeToken: data.qrcode,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    mode: 'polling',
    connected: false,
  });

  return {
    status: 'pending',
    sessionId: input.sessionId,
    qrcode: data.qrcode,
    qrcodeUrl,
    isImageData,
  };
}

/**
 * Long-poll iLink `/ilink/bot/get_qrcode_status` once. On `confirmed`, write
 * the real `bot_token` and `ilink_bot_id` back into the binding so the
 * monitor / outbound paths can find them.
 *
 * Reads the persisted `qrcodeToken` field from the binding record (written
 * by {@link startBindReal}); the caller MUST go through that flow first so
 * the token is available.
 */
export async function pollBindStatusReal(
  input: WeChatPollBindStatusInput,
  store: LocalWeChatChannelStore,
  options: { fetch?: WeChatFetch } = {},
): Promise<WeChatPollBindStatusResult> {
  const record = await store.getByBindSessionId(input.sessionId);
  if (!record) {
    return { status: 'expired', sessionId: input.sessionId, error: 'bind session expired' };
  }
  if (
    record.enabled &&
    record.connected &&
    record.botToken &&
    !record.botToken.startsWith('pending:')
  ) {
    return {
      status: 'confirmed',
      sessionId: input.sessionId,
      clientId: record.clientId,
      botToken: record.botToken,
      ilinkBotId: record.ilinkBotId ?? '',
      ...(record.baseUrl ? { baseUrl: record.baseUrl } : {}),
    };
  }
  const qrcode = record.qrcodeToken ?? '';
  if (!qrcode) {
    return { status: 'error', sessionId: input.sessionId, error: 'qrcode token missing' };
  }
  const baseUrl = ensureTrailingSlash(input.baseUrl ?? record.baseUrl ?? DEFAULT_ILINK_BASE_URL);
  const url = `${baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const doFetch = options.fetch ?? globalFetch();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  let resp: StatusResponse;
  try {
    const res = await doFetch(url, {
      headers: buildIlinkCommonHeaders(),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '(unreadable)');
      return {
        status: 'error',
        sessionId: input.sessionId,
        error: `status poll ${res.status}: ${body}`,
      };
    }
    resp = (await res.json()) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'pending', sessionId: input.sessionId, qrcodeUrl: record.qrcodeUrl };
    }
    return {
      status: 'error',
      sessionId: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }

  switch (resp.status) {
    case 'wait':
      return { status: 'pending', sessionId: input.sessionId, qrcodeUrl: record.qrcodeUrl };
    case 'scaned':
      return { status: 'scanned', sessionId: input.sessionId, qrcodeUrl: record.qrcodeUrl };
    case 'expired':
      return { status: 'expired', sessionId: input.sessionId, error: 'qr expired' };
    case 'confirmed':
      if (!resp.bot_token || !resp.ilink_bot_id) {
        return {
          status: 'error',
          sessionId: input.sessionId,
          error: 'confirmed without bot_token / ilink_bot_id',
        };
      }
      await finaliseBinding(store, record, {
        botToken: resp.bot_token,
        ilinkBotId: resp.ilink_bot_id,
        baseUrl: resp.baseurl,
      });
      return {
        status: 'confirmed',
        sessionId: input.sessionId,
        clientId: record.clientId,
        botToken: resp.bot_token,
        ilinkBotId: resp.ilink_bot_id,
        ...(resp.baseurl ? { baseUrl: resp.baseurl } : {}),
      };
    case 'scaned_but_redirect':
    case 'need_verifycode':
    case 'verify_code_blocked':
    case 'binded_redirect':
      return {
        status: 'error',
        sessionId: input.sessionId,
        error: `unsupported iLink QR status: ${resp.status}`,
      };
    default:
      return {
        status: 'error',
        sessionId: input.sessionId,
        error: formatUnknownStatus(resp),
      };
  }
}

function formatUnknownStatus(resp: StatusResponse): string {
  if (resp.errmsg || resp.errcode !== undefined) {
    return `iLink status error${resp.errcode !== undefined ? ` ${resp.errcode}` : ''}: ${resp.errmsg ?? 'unknown error'}`;
  }
  return `unexpected iLink QR status: ${String(resp.status ?? 'missing')}`;
}

/** Persist the confirmed credentials, switching mode to `polling`. */
async function finaliseBinding(
  store: LocalWeChatChannelStore,
  pending: LocalWeChatBindingRecord,
  input: { botToken: string; ilinkBotId: string; baseUrl?: string },
): Promise<void> {
  await store.bind({
    agentName: pending.agentName,
    botToken: input.botToken,
    ilinkBotId: input.ilinkBotId,
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(pending.botName ? { botName: pending.botName } : {}),
    ...(pending.bindSessionId ? { bindSessionId: pending.bindSessionId } : {}),
    ...(pending.qrcodeUrl ? { qrcodeUrl: pending.qrcodeUrl } : {}),
    mode: 'polling',
    connected: true,
  });
}

/** Compute the QR url + isImageData flag from the raw `qrcode_img_content`. */
export function normaliseQrContent(raw: string): { qrcodeUrl: string; isImageData: boolean } {
  if (!raw) return { qrcodeUrl: '', isImageData: false };
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return { qrcodeUrl: raw, isImageData: false };
  }
  if (raw.startsWith('weixin://') || raw.includes('://')) {
    return { qrcodeUrl: raw, isImageData: false };
  }
  if (raw.startsWith('data:image/')) {
    return { qrcodeUrl: raw, isImageData: true };
  }
  // Treat as raw base64 image data.
  return { qrcodeUrl: `data:image/png;base64,${raw}`, isImageData: true };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function globalFetch(): WeChatFetch {
  const g = globalThis as { fetch?: WeChatFetch };
  if (!g.fetch) throw new Error('globalThis.fetch is not available');
  return g.fetch.bind(globalThis);
}
