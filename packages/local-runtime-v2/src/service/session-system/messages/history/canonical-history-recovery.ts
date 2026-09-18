import {
  canonicalHistoryRevision,
  inspectCanonicalHistorySequence,
  type CanonicalHistoryEnvelope,
} from '../../sessions/representation/canonical-history-contract.js';

type CanonicalHistoryMessage = CanonicalHistoryEnvelope['message'];

type CanonicalHistoryRecoveryIssueKind =
  | 'invalid-assistant-tool-call'
  | 'invalid-tool-result'
  | 'orphan-tool-result'
  | 'interrupted-tool-round'
  | 'pending-tool-call-tail';

interface CanonicalHistoryRecoveryIssue {
  readonly kind: CanonicalHistoryRecoveryIssueKind;
  readonly recordIndex: number;
  readonly droppedCount: number;
}

export interface CanonicalHistoryRecoveryResult {
  readonly records: readonly CanonicalHistoryEnvelope[];
  readonly issues: readonly CanonicalHistoryRecoveryIssue[];
}

export interface CanonicalHistoryRecoveryOptions {
  /** Active reads preserve the final in-flight tool round; execution reads remove it. */
  readonly allowPendingToolCallTail: boolean;
}

interface PendingToolRound {
  readonly assistantIndex: number;
  readonly records: CanonicalHistoryEnvelope[];
  readonly expectedCalls: ReadonlyMap<string, string>;
  readonly seenIds: Set<string>;
}

interface RecoveryCollections {
  readonly retained: CanonicalHistoryEnvelope[];
  readonly issues: CanonicalHistoryRecoveryIssue[];
}

interface RecoveryStep {
  readonly advance: boolean;
  readonly pending: PendingToolRound | undefined;
}

type AssistantToolCalls =
  | { readonly valid: true; readonly calls: ReadonlyMap<string, string> }
  | { readonly valid: false };

type ToolResult =
  | { readonly valid: true; readonly id: string; readonly name: string }
  | { readonly valid: false };

/**
 * Removes only tool-protocol rows whose safe disposition is deterministic.
 * Ambiguous identity, compaction, and turn-config corruption still fails closed.
 */
export function repairCanonicalHistory(
  records: readonly CanonicalHistoryEnvelope[],
  options: CanonicalHistoryRecoveryOptions,
): CanonicalHistoryRecoveryResult {
  assertRecoveryInvariants(records);
  const retained: CanonicalHistoryEnvelope[] = [];
  const issues: CanonicalHistoryRecoveryIssue[] = [];
  let pending: PendingToolRound | undefined;
  let index = 0;

  while (index < records.length) {
    const envelope = requireEnvelope(records, index);
    const collections = { retained, issues };
    const step = pending
      ? recoverPendingRecord(envelope, index, pending, collections)
      : recoverSettledRecord(envelope, index, collections);
    pending = step.pending;
    if (step.advance) index += 1;
  }

  if (pending) settlePendingTail(pending, options, retained, issues);
  validateRecoveredRecords(retained, options.allowPendingToolCallTail);
  return { records: retained, issues };
}

function assertRecoveryInvariants(records: readonly CanonicalHistoryEnvelope[]): void {
  inspectCanonicalHistorySequence(records.map(projectRecoveryInvariantEnvelope));
  assertUniqueToolCallIdentities(records);
}

function projectRecoveryInvariantEnvelope(
  envelope: CanonicalHistoryEnvelope,
): CanonicalHistoryEnvelope {
  const message = envelope.message;
  if (message.role === 'assistant') {
    const content = message['content'];
    return {
      ...envelope,
      message: {
        ...message,
        content: Array.isArray(content) ? content.filter((block) => !isToolCallBlock(block)) : [],
      },
    };
  }
  if (message.role === 'toolResult') {
    return { ...envelope, message: { ...message, role: 'assistant', content: [] } };
  }
  return envelope;
}

function assertUniqueToolCallIdentities(records: readonly CanonicalHistoryEnvelope[]): void {
  const seen = new Set<string>();
  records.forEach((envelope, recordIndex) => {
    const content = envelope.message.role === 'assistant' ? envelope.message['content'] : undefined;
    if (!Array.isArray(content)) return;
    content.forEach((block) => {
      if (!isToolCallBlock(block)) return;
      const id = nonEmptyString(block['id']);
      if (!id) return;
      if (seen.has(id)) {
        throw new Error(
          `Canonical history sequence is invalid at record ${recordIndex + 1}: duplicate tool call identity ${id}`,
        );
      }
      seen.add(id);
    });
  });
}

function isToolCallBlock(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && value['type'] === 'toolCall';
}

function requireEnvelope(
  records: readonly CanonicalHistoryEnvelope[],
  index: number,
): CanonicalHistoryEnvelope {
  const envelope = records[index];
  if (envelope) return envelope;
  inspectCanonicalHistorySequence(records);
  throw new Error('Canonical history validation did not reject a missing record.');
}

function recoverPendingRecord(
  envelope: CanonicalHistoryEnvelope,
  index: number,
  pending: PendingToolRound,
  collections: RecoveryCollections,
): RecoveryStep {
  if (envelope.message.role !== 'toolResult') {
    collections.issues.push({
      kind: 'interrupted-tool-round',
      recordIndex: pending.assistantIndex,
      droppedCount: pending.records.length,
    });
    return { advance: false, pending: undefined };
  }
  const completed = consumePendingToolResult({ envelope, index, pending, collections });
  return { advance: true, pending: completed ? undefined : pending };
}

function consumePendingToolResult(input: {
  readonly envelope: CanonicalHistoryEnvelope;
  readonly index: number;
  readonly pending: PendingToolRound;
  readonly collections: RecoveryCollections;
}): boolean {
  const { envelope, index, pending, collections } = input;
  const result = readToolResult(envelope.message);
  if (!result.valid) {
    collections.issues.push({ kind: 'invalid-tool-result', recordIndex: index, droppedCount: 1 });
    return false;
  }
  const expectedName = pending.expectedCalls.get(result.id);
  if (!expectedName || pending.seenIds.has(result.id)) {
    collections.issues.push({ kind: 'orphan-tool-result', recordIndex: index, droppedCount: 1 });
    return false;
  }
  if (result.name !== expectedName) {
    collections.issues.push({ kind: 'invalid-tool-result', recordIndex: index, droppedCount: 1 });
    return false;
  }
  pending.seenIds.add(result.id);
  pending.records.push(envelope);
  const completed = pending.seenIds.size === pending.expectedCalls.size;
  if (completed) collections.retained.push(...pending.records);
  return completed;
}

function recoverSettledRecord(
  envelope: CanonicalHistoryEnvelope,
  index: number,
  collections: RecoveryCollections,
): RecoveryStep {
  if (envelope.message.role === 'toolResult') {
    collections.issues.push({
      kind: readToolResult(envelope.message).valid ? 'orphan-tool-result' : 'invalid-tool-result',
      recordIndex: index,
      droppedCount: 1,
    });
    return { advance: true, pending: undefined };
  }
  if (envelope.message.role !== 'assistant') {
    collections.retained.push(envelope);
    return { advance: true, pending: undefined };
  }
  const toolCalls = readAssistantToolCalls(envelope.message);
  if (!toolCalls.valid) {
    collections.issues.push({
      kind: 'invalid-assistant-tool-call',
      recordIndex: index,
      droppedCount: 1,
    });
    return { advance: true, pending: undefined };
  }
  if (toolCalls.calls.size === 0) {
    collections.retained.push(envelope);
    return { advance: true, pending: undefined };
  }
  return {
    advance: true,
    pending: {
      assistantIndex: index,
      records: [envelope],
      expectedCalls: toolCalls.calls,
      seenIds: new Set(),
    },
  };
}

function settlePendingTail(
  pending: PendingToolRound,
  options: CanonicalHistoryRecoveryOptions,
  retained: CanonicalHistoryEnvelope[],
  issues: CanonicalHistoryRecoveryIssue[],
): void {
  if (options.allowPendingToolCallTail) {
    retained.push(...pending.records);
    return;
  }
  issues.push({
    kind: 'pending-tool-call-tail',
    recordIndex: pending.assistantIndex,
    droppedCount: pending.records.length,
  });
}

function validateRecoveredRecords(
  records: readonly CanonicalHistoryEnvelope[],
  allowPendingToolCallTail: boolean,
): void {
  if (allowPendingToolCallTail) {
    inspectCanonicalHistorySequence(records);
    return;
  }
  canonicalHistoryRevision(records);
}

function readAssistantToolCalls(message: CanonicalHistoryMessage): AssistantToolCalls {
  const content = message['content'];
  if (!Array.isArray(content)) return { valid: false };
  const calls = new Map<string, string>();
  for (const block of content) {
    if (!isPlainRecord(block) || block['type'] !== 'toolCall') continue;
    const id = nonEmptyString(block['id']);
    const name = nonEmptyString(block['name']);
    if (!id || !name || !isPlainRecord(block['arguments']) || calls.has(id)) {
      return { valid: false };
    }
    calls.set(id, name);
  }
  return { valid: true, calls };
}

function readToolResult(message: CanonicalHistoryMessage): ToolResult {
  const id = nonEmptyString(message['toolCallId']);
  const name = nonEmptyString(message['toolName']);
  if (
    !id ||
    !name ||
    !Array.isArray(message['content']) ||
    typeof message['isError'] !== 'boolean'
  ) {
    return { valid: false };
  }
  return { valid: true, id, name };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
