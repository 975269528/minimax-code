/**
 * Pure helpers for {@link LocalWeChatChannelAdapter}, split out of
 * `wechat-adapter.ts` so that file stays within the layout budget (same
 * pattern as `wechat-attachments.ts` / `wechat-questionnaire.ts`).
 */
import type { LocalChannelContext } from '../../infra.js';

/**
 * WeChat iLink CDN host — different from the iLink REST API host stored on
 * the binding (`baseUrl` ~ `https://ilinkai.weixin.qq.com`). Upload + download
 * must always go through this CDN; using the API host returns 404 because
 * `/upload` and `/download` only exist on the CDN edge.
 *
 * Mirrors the historical `apps/electron/main/modules/imGateway/platforms/wechat.ts`
 * constant from `feat/im-genui-full-mr` so behaviour stays bit-for-bit
 * identical with the proven gateway path.
 */
export const WECHAT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** First trimmed non-empty string under any of `keys` in `raw`. */
export function readString(
  raw: Record<string, unknown> | undefined,
  keys: string[],
): string | undefined {
  if (!raw) return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function readContextTokenFromCtx(ctx: LocalChannelContext): string | undefined {
  // Two carriers seen in the wild:
  //   1) `ctx.contextToken`            — extension field the monitor wire
  //      adds on the inbound path (same turn dispatch keeps the field on
  //      the live ctx reference).
  //   2) `ctx.platformSpecific.contextToken` — parity with the historical
  //      IM Gateway path (`toMessageContext` packed the token there).
  // The adapter's `contextTokenByChat` map is consulted by the caller as a
  // chat-scoped fallback when both per-message fields are missing (e.g. the
  // runner reconstructs ctx around an async turn boundary).
  const direct = (ctx as unknown as { contextToken?: string }).contextToken;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const platformSpecific = (ctx as unknown as { platformSpecific?: Record<string, unknown> })
    .platformSpecific;
  const fromPlatform = platformSpecific?.['contextToken'];
  if (typeof fromPlatform === 'string' && fromPlatform.trim()) return fromPlatform.trim();
  return undefined;
}
