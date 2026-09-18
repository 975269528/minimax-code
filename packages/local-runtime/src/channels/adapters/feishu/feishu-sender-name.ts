import type { FeishuSender } from './feishu-sender.js';

export async function enrichFeishuSenderName(
  body: Record<string, unknown>,
  sender: FeishuSender,
): Promise<Record<string, unknown>> {
  const payload = isRecord(body.payload) ? body.payload : body;
  const event = isRecord(payload.event) ? payload.event : payload;
  const currentSender = isRecord(event.sender) ? event.sender : undefined;
  if (
    !currentSender ||
    readFirstString(currentSender, ['senderName', 'sender_name', 'name', 'nickname'])
  ) {
    return body;
  }
  const senderId = isRecord(currentSender.sender_id) ? currentSender.sender_id : {};
  const openId = readFirstString(senderId, ['open_id']);
  if (!openId) return body;
  const senderName =
    (await sender.getUserDisplayName(openId).catch(() => undefined)) ?? openId.slice(-6);
  currentSender.sender_name = senderName;
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readFirstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return undefined;
}
