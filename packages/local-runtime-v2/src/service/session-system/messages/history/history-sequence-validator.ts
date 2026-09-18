interface HistoryMessage extends Record<string, unknown> {
  readonly role: string;
}

interface HistoryEnvelope {
  readonly message_id: string;
  readonly message: HistoryMessage;
}

/** Fail-closed semantic validation used before a legacy history becomes canonical. */
export function assertCanonicalHistorySequence(
  envelopes: readonly HistoryEnvelope[],
  sessionId: string,
): void {
  const state: SequenceValidationState = {
    messageIds: new Set<string>(),
    compactionBoundarySeen: false,
  };
  envelopes.forEach((envelope, index) => validateEnvelope(envelope, index, sessionId, state));
  if (state.pendingToolCallIds && state.pendingToolCallIds.size > 0) {
    fail(
      sessionId,
      envelopes.length,
      `history ends before tool results: ${[...state.pendingToolCallIds].join(',')}`,
    );
  }
}

interface SequenceValidationState {
  readonly messageIds: Set<string>;
  compactionBoundarySeen: boolean;
  pendingToolCallIds?: Set<string>;
}

function validateEnvelope(
  envelope: HistoryEnvelope,
  index: number,
  sessionId: string,
  state: SequenceValidationState,
): void {
  if (state.messageIds.has(envelope.message_id)) {
    fail(sessionId, index, `duplicate message identity ${envelope.message_id}`);
  }
  state.messageIds.add(envelope.message_id);
  if (readCompactionBoundary(envelope.message, sessionId, index)) {
    if (state.compactionBoundarySeen || index !== 0) {
      fail(sessionId, index, 'compaction boundary must be the unique first message');
    }
    state.compactionBoundarySeen = true;
  }
  if (envelope.message.role === 'toolResult') {
    validateToolResult(envelope.message, index, sessionId, state);
    return;
  }
  requireSettledToolCalls(index, sessionId, state);
  if (envelope.message.role === 'assistant') {
    state.pendingToolCallIds = readAssistantToolCallIds(envelope.message, index, sessionId);
  }
}

function validateToolResult(
  message: HistoryMessage,
  index: number,
  sessionId: string,
  state: SequenceValidationState,
): void {
  const toolCallId = nonEmpty(message['toolCallId']);
  if (!toolCallId || !state.pendingToolCallIds?.has(toolCallId)) {
    fail(sessionId, index, `orphan or out-of-order tool result ${toolCallId ?? '<missing>'}`);
  }
  state.pendingToolCallIds.delete(toolCallId);
  if (state.pendingToolCallIds.size === 0) state.pendingToolCallIds = undefined;
}

function requireSettledToolCalls(
  index: number,
  sessionId: string,
  state: SequenceValidationState,
): void {
  if (!state.pendingToolCallIds || state.pendingToolCallIds.size === 0) return;
  fail(
    sessionId,
    index,
    `tool results must immediately follow their assistant call: ${[...state.pendingToolCallIds].join(',')}`,
  );
}

function readAssistantToolCallIds(
  message: HistoryMessage,
  index: number,
  sessionId: string,
): Set<string> | undefined {
  const content = message['content'];
  if (!Array.isArray(content)) fail(sessionId, index, 'assistant content must be an array');
  const toolCallIds = content.flatMap((block, blockIndex) =>
    readToolCallId(block, blockIndex, index, sessionId),
  );
  if (new Set(toolCallIds).size !== toolCallIds.length) {
    fail(sessionId, index, 'assistant contains duplicate tool call identities');
  }
  return toolCallIds.length > 0 ? new Set(toolCallIds) : undefined;
}

function readToolCallId(
  block: unknown,
  blockIndex: number,
  messageIndex: number,
  sessionId: string,
): string[] {
  if (!isRecord(block) || block['type'] !== 'toolCall') return [];
  const id = nonEmpty(block['id']);
  if (!id) fail(sessionId, messageIndex, `tool call ${blockIndex} has no identity`);
  return [id];
}

function readCompactionBoundary(
  message: HistoryMessage,
  sessionId: string,
  index: number,
): boolean {
  if (message.role === 'compactionSummary') {
    if (!isNativeCompactionSummary(message)) {
      fail(sessionId, index, 'legacy compaction summary is malformed');
    }
    return true;
  }

  if (!Object.hasOwn(message, 'archonCompaction')) return false;
  const marker = message['archonCompaction'];
  if (message.role !== 'user' || !isArchonCompactionMarker(marker)) {
    fail(sessionId, index, 'Archon compaction boundary is malformed');
  }
  return true;
}

function isNativeCompactionSummary(message: HistoryMessage): boolean {
  if (typeof message['summary'] !== 'string') return false;
  const hasTokens = Object.hasOwn(message, 'tokensBefore');
  const hasTimestamp = Object.hasOwn(message, 'timestamp');
  if (!hasTokens && !hasTimestamp) {
    return Object.keys(message).every((key) => key === 'role' || key === 'summary');
  }
  const tokensBefore = message['tokensBefore'];
  const timestamp = message['timestamp'];
  return (
    hasTokens === hasTimestamp &&
    typeof tokensBefore === 'number' &&
    Number.isSafeInteger(tokensBefore) &&
    tokensBefore >= 0 &&
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp)
  );
}

function isArchonCompactionMarker(value: unknown): boolean {
  if (!isRecord(value) || typeof value['summary'] !== 'string') return false;
  if (value['schemaVersion'] === 1) return true;
  if (value['version'] !== 2 || !Array.isArray(value['recentUserQueries'])) return false;
  const queriesValid = value['recentUserQueries'].every(
    (query) =>
      isRecord(query) &&
      nonEmpty(query['text']) !== undefined &&
      (query['timestampMs'] === undefined ||
        (typeof query['timestampMs'] === 'number' && Number.isFinite(query['timestampMs']))),
  );
  if (!queriesValid || value['todoState'] === undefined) return queriesValid;
  return (
    Array.isArray(value['todoState']) &&
    value['todoState'].every(
      (item) =>
        isRecord(item) &&
        nonEmpty(item['content']) !== undefined &&
        nonEmpty(item['status']) !== undefined &&
        nonEmpty(item['priority']) !== undefined,
    )
  );
}

function fail(sessionId: string, index: number, reason: string): never {
  throw new Error(`Canonical Pi history sequence is invalid: ${sessionId}:${index + 1}: ${reason}`);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
