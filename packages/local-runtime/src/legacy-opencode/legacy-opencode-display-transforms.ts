import crypto from 'node:crypto';

import { type AgentMessage } from '@mavis/agent-core/protocol/agent-message';
import { sanitizeWireToolCallResultData } from '@mavis/agent-core/event-bridge';

/**
 * Pure display-message transform helpers shared by the legacy OpenCode
 * migrator's array path and its streamed display-import path. Extracted from
 * `legacy-opencode-migrator.ts` to keep that file under the repo source-size
 * gate; behaviour is unchanged (moved verbatim).
 *
 * All functions here are stateless with respect to module scope and operate
 * only on their arguments, which is what makes them safe to drive both from a
 * whole-array pass and from a per-message streamed pipeline.
 */

export function checksumJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function mergeDisplayMessages(
  legacyMessages: AgentMessage[],
  existingMessages: AgentMessage[],
  options: { duplicateSourceMsgIds?: string[] } = {},
): AgentMessage[] {
  const duplicateSourceMsgIds = new Set(options.duplicateSourceMsgIds ?? []);
  const existingById = new Map(
    existingMessages
      .filter((message) => message.msg_id)
      .filter((message) => !duplicateSourceMsgIds.has(message.msg_id!))
      .map((message) => [message.msg_id, message] as const),
  );
  const seen = new Set<string>();
  const merged: AgentMessage[] = [];
  for (const legacyMessage of legacyMessages) {
    if (legacyMessage.msg_id) seen.add(legacyMessage.msg_id);
    merged.push(
      legacyMessage.msg_id
        ? (existingById.get(legacyMessage.msg_id) ?? legacyMessage)
        : legacyMessage,
    );
  }
  for (const existingMessage of existingMessages) {
    if (existingMessage.msg_id && seen.has(existingMessage.msg_id)) continue;
    merged.push(existingMessage);
  }
  return merged;
}

export function preferExistingDisplayMessages(
  legacyMessages: AgentMessage[],
  existingMessages: AgentMessage[],
  options: { duplicateSourceMsgIds?: string[] } = {},
): AgentMessage[] {
  const duplicateSourceMsgIds = new Set(options.duplicateSourceMsgIds ?? []);
  const existingById = new Map(
    existingMessages
      .filter((message) => message.msg_id)
      .map((message) => [message.msg_id, message] as const),
  );
  const existingSyntheticByFingerprint = new Map<string, AgentMessage[]>();
  for (const message of existingMessages) {
    if (!isLocalStoreSyntheticMessageId(message.msg_id)) continue;
    const fingerprint = missingIdMessageFingerprint(message);
    const matches = existingSyntheticByFingerprint.get(fingerprint) ?? [];
    matches.push(message);
    existingSyntheticByFingerprint.set(fingerprint, matches);
  }
  return legacyMessages.map((message) => {
    if (message.msg_id) {
      const existing = duplicateSourceMsgIds.has(message.msg_id)
        ? undefined
        : existingById.get(message.msg_id);
      if (existing) return existing;
      if (isLegacyMissingMessageId(message.msg_id)) {
        const matches = existingSyntheticByFingerprint.get(missingIdMessageFingerprint(message));
        const match = matches?.shift();
        if (match) return match;
      }
    }
    return message;
  });
}

export function isLegacyMissingMessageId(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('legacy-missing-msg-id-');
}

export function isLocalStoreSyntheticMessageId(value: unknown): boolean {
  return typeof value === 'string' && /^msg-\d+-[a-zA-Z0-9_-]+$/.test(value);
}

export function missingIdMessageFingerprint(message: AgentMessage): string {
  const record = message as AgentMessage & {
    created_at?: unknown;
    attachments?: unknown;
  };
  return checksumJson({
    role: record.role ?? null,
    msgType: record.msg_type ?? null,
    content: record.msg_content ?? null,
    timestamp: record.timestamp ?? record.created_at ?? null,
    toolCalls: record.tool_calls ?? null,
    attachments: Array.isArray(record.attachments)
      ? record.attachments.map(stableAttachmentFingerprint)
      : [],
  });
}

export function stableAttachmentFingerprint(attachment: unknown): Record<string, unknown> {
  if (!attachment || typeof attachment !== 'object') return {};
  const record = attachment as Record<string, unknown>;
  return {
    type: record.type ?? null,
    fileName: record.file_name ?? record.fileName ?? null,
    mimeType: record.mime_type ?? record.mimeType ?? null,
  };
}

export function prepareLegacyDisplayMessages(messages: AgentMessage[]): {
  messages: AgentMessage[];
  warnings: string[];
  duplicateMsgIdsRewritten: number;
  missingMsgIdsAssigned: number;
  duplicateSourceMsgIds: string[];
} {
  const seen = new Map<string, number>();
  const duplicateSourceMsgIds = new Set<string>();
  let duplicateMsgIdsRewritten = 0;
  let missingMsgIdsAssigned = 0;
  const prepared = messages.map((message, index) => {
    const original =
      typeof message.msg_id === 'string' && message.msg_id.trim() ? message.msg_id : undefined;
    const base = original ?? `legacy-missing-msg-id-${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if (!original) {
      missingMsgIdsAssigned += 1;
      return { ...message, msg_id: `${base}-${checksumJson(message).slice(0, 12)}` };
    }
    if (count > 0) {
      duplicateMsgIdsRewritten += 1;
      duplicateSourceMsgIds.add(base);
      return { ...message, msg_id: `${base}__legacy_dup_${count + 1}_${index + 1}` };
    }
    return message;
  });
  const warnings = [
    ...(duplicateMsgIdsRewritten > 0
      ? [`legacy_duplicate_msg_id_rewritten:${duplicateMsgIdsRewritten}`]
      : []),
    ...(missingMsgIdsAssigned > 0
      ? [`legacy_missing_msg_id_assigned:${missingMsgIdsAssigned}`]
      : []),
  ];
  return {
    messages: prepared,
    warnings,
    duplicateMsgIdsRewritten,
    missingMsgIdsAssigned,
    duplicateSourceMsgIds: [...duplicateSourceMsgIds],
  };
}

export function sanitizeDisplayMessagesForImport(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!message.tool_calls?.length) return message;
    const tool_calls = message.tool_calls.map((tc) => {
      if (typeof tc.tool_call_result_data !== 'string') return tc;
      const cleaned = sanitizeWireToolCallResultData(tc.tool_call_result_data);
      return cleaned === tc.tool_call_result_data ? tc : { ...tc, tool_call_result_data: cleaned };
    });
    const changed = tool_calls.some((tc, idx) => tc !== message.tool_calls![idx]);
    return changed ? { ...message, tool_calls } : message;
  });
}
