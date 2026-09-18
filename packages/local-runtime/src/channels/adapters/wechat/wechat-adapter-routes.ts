/**
 * WeChat unified-channel route helper — mirrors `telegram-adapter-routes.ts`
 * shape so the infra route table can hand off `/channel-bridge/wechat/*`
 * requests to the registry-backed adapter.
 *
 * Currently exposes only the `inbound` endpoint; bind/unbind/status remain on
 * the legacy `LocalWeChatChannelApi` paths until the unified flow gains
 * feature parity. Inbound goes through `adapter.normalizeInbound` and then
 * resolves attachments via the adapter's `downloadAttachmentToLocal`,
 * matching the multimodal coverage of the legacy `wechat.handleEvent` path.
 */

import { json, readFirstString, readJsonBody } from '../../../api/http-helpers.js';

import type { LocalChannelAdapterRegistry } from '../../adapter-registry.js';
import type { LocalChannelPlatformAdapter } from '../../adapter.js';
import type { ChannelInboundAttachmentRef, ChannelInboundEnvelope } from '../../envelope.js';
import type { LocalChannelContext } from '../../infra.js';
import type { LocalMessageAttachment } from '../../../messages/input.js';
import { wechatClientId } from '../../wechat.js';

export interface WeChatAdapterRouteDispatcher {
  dispatchInbound?: (input: {
    ctx: LocalChannelContext;
    text: string;
    eventId?: string;
    attachments?: LocalMessageAttachment[];
  }) => Promise<unknown>;
  defaultAgentName?: string;
}

const ADAPTER_UNAVAILABLE = {
  status: 503,
  body: { ok: false, error: 'wechat adapter not registered', code: 'ADAPTER_UNAVAILABLE' },
} as const;

/**
 * Handle a registry-backed `/channel-bridge/wechat/*` request. Returns
 * `undefined` for paths that are not handled here (the infra route table
 * then falls through to legacy WeChat routes).
 */
export async function dispatchWeChatAdapterRoute(input: {
  method: string;
  path: string;
  request: Request;
  registry: LocalChannelAdapterRegistry;
  dispatcher?: WeChatAdapterRouteDispatcher;
}): Promise<Response | undefined> {
  const { method, path, request, registry, dispatcher } = input;
  const defaultAgentName = dispatcher?.defaultAgentName ?? 'mavis';

  if (method === 'POST' && path === 'wechat/inbound') {
    const body = await readJsonBody(request);
    const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? defaultAgentName;
    const adapter = registry.get('wechat', wechatClientId(agentName));
    if (!adapter) return json(ADAPTER_UNAVAILABLE.body, { status: ADAPTER_UNAVAILABLE.status });
    let envelope: ChannelInboundEnvelope;
    try {
      envelope = await adapter.normalizeInbound({ clientName: adapter.clientName, raw: body });
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

async function downloadAttachmentsForUnifiedInbound(
  adapter: LocalChannelPlatformAdapter,
  envelope: ChannelInboundEnvelope,
): Promise<LocalMessageAttachment[]> {
  const refs = envelope.attachmentRefs ?? [];
  if (refs.length === 0 || !adapter.downloadAttachmentToLocal) return [];
  const messageId = envelope.messageId ?? envelope.eventId;
  const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
  const settled = await Promise.allSettled(
    refs.map((ref) =>
      adapter.downloadAttachmentToLocal!({
        clientName: adapter.clientName,
        ref,
        ...(messageId ? { messageId } : {}),
        sessionId,
      }),
    ),
  );
  const out: LocalMessageAttachment[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const r = settled[i]!;
    const ref = refs[i]!;
    if (r.status === 'fulfilled') {
      out.push({
        type: r.value.type,
        filePath: r.value.filePath,
        fileName: r.value.fileName,
        mimeType: r.value.mimeType,
        ...(r.value.error ? { error: r.value.error } : {}),
      });
    } else {
      out.push({
        type: ref.type === 'image' ? 'image' : 'file',
        filePath: '',
        fileName: ref.name ?? ref.key ?? 'attachment',
        mimeType: ref.mimeType ?? 'application/octet-stream',
        error: 'download_failed',
      });
    }
  }
  return out;
}

function ensureUnifiedInboundText(
  text: string,
  refs: ChannelInboundAttachmentRef[] | undefined,
): string {
  if (text.trim()) return text;
  if (!refs || refs.length === 0) return text;
  const primary = refs[0]!;
  if (primary.type === 'image') return '[图片]';
  if (primary.type === 'audio') return '[语音]';
  if (primary.type === 'video') return '[视频]';
  return `[文件] ${primary.name ?? primary.key ?? ''}`.trim();
}
