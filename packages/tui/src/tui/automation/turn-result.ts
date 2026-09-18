import type { ExecResultError, ExecResultV1 } from '../../application/exec-result.js';
import type { TuiSettledTurn } from '../controller/chat-controller-types.js';
import type { TranscriptStore } from '../transcript/store.js';

export interface CreateTuiAutomationTurnResultInput {
  readonly settledTurn: TuiSettledTurn;
  readonly transcript: TranscriptStore;
  readonly durationMs?: number;
  readonly error?: ExecResultError;
}

export function createTuiAutomationTurnResult(
  input: CreateTuiAutomationTurnResultInput,
): ExecResultV1 {
  const answer = latestAssistantAnswerForTurn(input.transcript, input.settledTurn.turnId);
  let status: ExecResultV1['status'] = input.settledTurn.status;
  let error = input.error;
  if (status === 'succeeded' && answer === null) {
    status = 'failed';
    error = {
      category: 'runtime',
      code: 'EMPTY_RESPONSE',
      message: 'Runtime completed without a final assistant response.',
      retryable: true,
    };
  } else if (status === 'failed' && !error) {
    error = {
      category: 'runtime',
      message: 'Runtime turn failed.',
    };
  }

  return {
    schemaVersion: 1,
    type: 'exec.result',
    sessionId: input.settledTurn.sessionId,
    turnId: input.settledTurn.turnId,
    status,
    answer,
    ...(error ? { error } : {}),
    durationMs: validDuration(input.durationMs),
  };
}

function latestAssistantAnswerForTurn(transcript: TranscriptStore, turnId: string): string | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const cell = transcript.cellAt(index);
    if (
      !cell ||
      cell.ephemeral ||
      cell.turnId !== turnId ||
      cell.kind !== 'assistant' ||
      !cell.content.trim()
    ) {
      continue;
    }
    return cell.content;
  }
  return null;
}

function validDuration(durationMs: number | undefined): number {
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0
    ? durationMs
    : 0;
}
