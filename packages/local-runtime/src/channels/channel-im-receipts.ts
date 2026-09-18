import type { ChannelPlatform } from './route-api.js';
import { LocalChannelRootlessError } from './rootless-route-resolver.js';
import { imLogger as logger } from '../common/im-logger.js';
import { resolveLocalRuntimeLocale } from '../runtime/locale.js';
import { isChineseLocale } from '../utils/locale.js';

/** Internal identifiers for a V2 IM Connection route; never a legacy Binding. */
export interface LocalImRouteMetadata {
  connectionId: string;
  bindingId: string;
  /** Retained only for a Binding that was migrated from the old YAML map. */
  imConversationId?: string;
}

/** Metadata for a generated V2 IM receipt. It intentionally contains no external identity or text. */
export interface LocalChannelImReceipt {
  /** Hashed request correlation key; never log the raw mutation receipt id. */
  requestKey: string;
  code: string;
  stage: 'route_validation' | 'enqueue' | 'new_receipt';
  imRoute: LocalImRouteMetadata;
  sessionId?: string;
}

// ── Route-broken IM receipts (product decision 2026-09-04) ──────────────────
//
// Human-readable copy sent back to the IM user when the Channel route can no
// longer be resolved (bound Agent deleted / binding stale / session invalid).
// Historical route codes preserve their platform language convention. V2 IM
// Connection receipts use the Desktop runtime locale so all transports match
// the product language. Copy is aligned with archon_server's im-guard flow.

const channelRouteAgentGoneZH =
  '你绑定的 Agent 已被删除或绑定已失效，无法继续对话。请在 App 中重新绑定后再试。';
const channelRouteAgentGoneEN =
  'The Agent bound to this chat has been deleted or the binding is stale. Please rebind it in the App and try again.';
const channelRouteSessionGoneZH = '当前绑定的会话已失效。请在 App 中重新绑定后再试。';
const channelRouteSessionGoneEN =
  'The bound conversation is no longer valid. Please rebind it in the App and try again.';
const channelRouteGenericZH = '渠道消息处理失败，请稍后再试，或在 App 中检查绑定。';
const channelRouteGenericEN =
  'The channel message could not be processed. Please retry later or check the binding in the App.';
const channelImSessionDeletedZH = '当前绑定的会话已删除，请发送 /new 创建新会话后继续。';
const channelImSessionDeletedEN =
  'This conversation has been deleted. Send /new to start a new conversation and continue.';
const channelImNewCreatedZH = '已创建新会话，请继续发送消息。';
const channelImNewCreatedEN = 'A new conversation has been created. Send a message to continue.';

/** Maps a LocalChannelRootlessError code to the localized receipt text. */
export function channelRouteBrokenReceiptText(platform: string, code: string): string {
  const chineseLocale = isChineseLocale(resolveLocalRuntimeLocale());
  if (code === 'CHANNEL_IM_AGENT_UNAVAILABLE') {
    return chineseLocale ? channelRouteAgentGoneZH : channelRouteAgentGoneEN;
  }
  if (code === 'CHANNEL_IM_SESSION_DELETED') {
    return chineseLocale ? channelImSessionDeletedZH : channelImSessionDeletedEN;
  }
  const en = platform === 'telegram';
  switch (code) {
    case 'CHANNEL_BINDING_STALE':
    case 'CHANNEL_BINDING_NOT_FOUND':
    case 'CHANNEL_BINDING_AMBIGUOUS':
    case 'CHANNEL_ROUTE_OWNER_STALE':
    case 'CHANNEL_BINDING_OWNER_CHANGE_REQUIRES_REBIND':
    case 'CHANNEL_BINDING_PROFILE_DIVERGED':
      return en ? channelRouteAgentGoneEN : channelRouteAgentGoneZH;
    case 'CHANNEL_SESSION_VALIDATION_FAILED':
      return en ? channelRouteSessionGoneEN : channelRouteSessionGoneZH;
    default:
      return en ? channelRouteGenericEN : channelRouteGenericZH;
  }
}

export function channelImNewCreatedReceiptText(): string {
  return isChineseLocale(resolveLocalRuntimeLocale())
    ? channelImNewCreatedZH
    : channelImNewCreatedEN;
}

export function imReceiptFromRouteError(
  error: LocalChannelRootlessError,
  stage: LocalChannelImReceipt['stage'],
  requestKey: string,
): LocalChannelImReceipt | undefined {
  if (!error.imRoute) return undefined;
  return {
    requestKey,
    code: error.code,
    stage,
    imRoute: error.imRoute,
    ...(error.imRoute.sessionId ? { sessionId: error.imRoute.sessionId } : {}),
  };
}

export function imReceiptForRoute(
  route: { imRoute?: LocalImRouteMetadata; sessionId?: string },
  code: string,
  stage: LocalChannelImReceipt['stage'],
  requestKey: string,
): LocalChannelImReceipt | undefined {
  if (!route.imRoute) return undefined;
  return {
    requestKey,
    code,
    stage,
    imRoute: route.imRoute,
    ...(route.sessionId ? { sessionId: route.sessionId } : {}),
  };
}

export function logImReceipt(
  ctx: { platform: ChannelPlatform },
  receipt: LocalChannelImReceipt,
  outcome: string,
  message: string,
): void {
  logger.warn(
    {
      requestKey: receipt.requestKey,
      platform: ctx.platform,
      connectionId: receipt.imRoute.connectionId,
      bindingId: receipt.imRoute.bindingId,
      ...(receipt.imRoute.imConversationId
        ? { imConversationId: receipt.imRoute.imConversationId }
        : {}),
      ...(receipt.sessionId ? { sessionId: receipt.sessionId } : {}),
      stage: receipt.stage,
      code: receipt.code,
      outcome,
    },
    message,
  );
}

export function isMissingEnqueueSessionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; reason?: unknown };
  return candidate.reason === 'session-not-found' || candidate.code === 'SESSION_NOT_FOUND';
}

/** Keep delivery-only receipt metadata out of adapter HTTP response JSON. */
export function keepImReceiptInternal<T extends { imReceipt?: LocalChannelImReceipt }>(
  result: T,
): T {
  if (result.imReceipt) {
    Object.defineProperty(result, 'imReceipt', {
      value: result.imReceipt,
      enumerable: false,
      configurable: true,
    });
  }
  return result;
}
