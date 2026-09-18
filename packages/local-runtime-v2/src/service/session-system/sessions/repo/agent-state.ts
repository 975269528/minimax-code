import { sessionAgentState } from '../../../../infra/db/schema/sessions.js';
import type { AgentSessionStateMutation, AgentSessionStateWriteResult } from './contract.js';

export type AgentStateRow = typeof sessionAgentState.$inferSelect;

export function decideAgentState(
  current: AgentStateRow | undefined,
  input: AgentSessionStateMutation,
): 'apply' | Exclude<AgentSessionStateWriteResult['status'], 'not-found'> {
  if (!current) return 'apply';
  if (input.turnSequence < current.turnSequence) return 'stale';
  if (input.turnSequence > current.turnSequence) return 'apply';
  if (input.turnId !== current.turnId) return 'conflict';
  if (current.terminalOutcome) return decideTerminalState(current, input);
  if (input.eventId === current.eventId) return 'duplicate';
  if (
    input.runtimeSeq !== undefined &&
    current.runtimeSeq !== null &&
    input.runtimeSeq <= current.runtimeSeq
  ) {
    return 'duplicate';
  }
  return 'apply';
}

export function agentStateRow(
  current: AgentStateRow | undefined,
  input: AgentSessionStateMutation,
  nowMs: number,
): AgentStateRow {
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    turnSequence: input.turnSequence,
    runtimeSeq: resolvedRuntimeSeq(current, input),
    eventId: input.eventId,
    terminalOutcome: input.terminalOutcome ?? null,
    updatedAtMs: nowMs,
  };
}

function decideTerminalState(
  current: AgentStateRow,
  input: AgentSessionStateMutation,
): Exclude<AgentSessionStateWriteResult['status'], 'not-found' | 'applied'> {
  if (!input.terminalOutcome) return 'stale';
  if (
    input.runtimeSeq !== undefined &&
    current.runtimeSeq !== null &&
    input.runtimeSeq < current.runtimeSeq
  ) {
    return 'stale';
  }
  return input.eventId === current.eventId &&
    resolvedRuntimeSeq(current, input) === current.runtimeSeq &&
    input.terminalOutcome === current.terminalOutcome
    ? 'duplicate'
    : 'conflict';
}

export function assertAgentStateMutation(input: AgentSessionStateMutation): void {
  if (
    !input.sessionId ||
    !input.turnId ||
    !input.eventId ||
    !Number.isSafeInteger(input.turnSequence) ||
    input.turnSequence <= 0 ||
    (input.runtimeSeq !== undefined &&
      (!Number.isSafeInteger(input.runtimeSeq) || input.runtimeSeq <= 0))
  ) {
    throw new TypeError('Agent Session state mutation has an invalid identity.');
  }
}

function resolvedRuntimeSeq(
  current: AgentStateRow | undefined,
  input: AgentSessionStateMutation,
): number | null {
  if (input.runtimeSeq !== undefined) return input.runtimeSeq;
  if (current?.turnSequence !== input.turnSequence || current.turnId !== input.turnId) return null;
  return current.runtimeSeq;
}
