import type { TranscriptStore } from '../../transcript/store.js';

export type LiveSegmentKind = 'thinking' | 'assistant' | 'tool';

export interface TurnStreamProjection {
  begun: boolean;
  pendingThinkingStartedAtMs?: number;
  activeKind?: LiveSegmentKind;
  activeThinkingId?: string;
  activeAssistantId?: string;
  activeAssistantMessageId?: string;
  activeAssistantFinalized: boolean;
  thinkingCount: number;
  assistantCount: number;
  assistantByMessageId: Map<string, string>;
  thinkingByMessageId: Map<string, string>;
  streamStartedAtMs: Map<string, number>;
}

export function createTurnStreamProjection(): TurnStreamProjection {
  return {
    begun: false,
    activeAssistantFinalized: false,
    thinkingCount: 0,
    assistantCount: 0,
    assistantByMessageId: new Map(),
    thinkingByMessageId: new Map(),
    streamStartedAtMs: new Map(),
  };
}

export function releaseActiveMessageBindings(projection: TurnStreamProjection): void {
  for (const [messageId, thinkingId] of projection.thinkingByMessageId) {
    if (thinkingId !== projection.activeThinkingId) continue;
    projection.thinkingByMessageId.delete(messageId);
    projection.streamStartedAtMs.delete(messageId);
  }
  for (const [messageId, assistantId] of projection.assistantByMessageId) {
    if (assistantId !== projection.activeAssistantId) continue;
    projection.assistantByMessageId.delete(messageId);
    projection.streamStartedAtMs.delete(messageId);
  }
}

export function bindCurrentAssistantSnapshot(
  transcript: TranscriptStore,
  turnId: string,
  projection: TurnStreamProjection,
  messageId: string | undefined,
): void {
  const assistantId = projection.activeAssistantId;
  if (
    !messageId ||
    !assistantId ||
    projection.activeAssistantFinalized ||
    projection.assistantByMessageId.has(messageId)
  ) {
    return;
  }

  projection.assistantByMessageId.set(messageId, assistantId);
  if (projection.thinkingByMessageId.has(messageId)) return;

  const cells = transcript.snapshot();
  const assistantIndex = cells.findIndex((cell) => cell.id === assistantId);
  const preceding = assistantIndex > 0 ? cells[assistantIndex - 1] : undefined;
  if (preceding?.kind === 'thinking' && preceding.turnId === turnId) {
    projection.thinkingByMessageId.set(messageId, preceding.id);
  }
}

export function nextThinkingId(turnId: string, projection: TurnStreamProjection): string {
  projection.thinkingCount += 1;
  return projection.thinkingCount === 1
    ? `thinking:${turnId}`
    : `thinking:${turnId}:${projection.thinkingCount}`;
}

export function observedThinkingDuration(
  projection: TurnStreamProjection,
  messageId: string | undefined,
  timestamp: number,
): number | undefined {
  const startedAtMs = messageId ? projection.streamStartedAtMs.get(messageId) : undefined;
  return startedAtMs === undefined ? undefined : Math.max(0, timestamp - startedAtMs);
}

export function effectiveThinkingDuration(...candidates: Array<number | undefined>): {
  durationMs?: number;
} {
  const durations = candidates.filter((value): value is number => value !== undefined);
  return durations.length > 0 ? { durationMs: Math.max(0, ...durations) } : {};
}
