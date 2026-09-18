import type { ConversationAttachment } from '@mavis/conversation-contract';

import { isInlineDisplayDataUrl } from '../../session-system/index.js';
import type { RegisteredConversationAttachment } from './contracts.js';

export function needsAttachmentRegistration(attachment: ConversationAttachment): boolean {
  // Callers may hold local paths temporarily; persist them through the asset layer or reuse an existing asset before admission.
  return Boolean(attachment.filePath?.trim()) || isInlineDisplayDataUrl(attachment.dataUrl);
}

export function requireRegisteredAttachment(
  attachment: RegisteredConversationAttachment | undefined,
  index: number,
): ConversationAttachment {
  if (!attachment?.filePath?.trim() || isInlineDisplayDataUrl(attachment.dataUrl)) {
    throw new TypeError(
      `Attachment registration returned an invalid result at index ${String(index)}.`,
    );
  }
  const safeAttachment = { ...attachment };
  delete safeAttachment.registrationReceipt;
  return withoutInlineDataUrl(safeAttachment);
}

export function withoutInlineDataUrl(attachment: ConversationAttachment): ConversationAttachment {
  if (!isInlineDisplayDataUrl(attachment.dataUrl)) return attachment;
  const sanitized = { ...attachment };
  delete sanitized.dataUrl;
  return sanitized;
}
