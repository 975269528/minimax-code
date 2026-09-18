import type { LocalSessionRecord, LocalSessionStatus } from '../sessions/controller.js';
import type { LocalMemoryFacade } from './local-memory-facade.js';
import { formatLocalDate } from './local-memory-store-utils.js';
import { LocalMemoryError } from './types.js';
import type { GlobalEventPublisher } from '../events/global-events.js';

export type LocalMemoryBusEmitter = (type: string, payload: Record<string, unknown>) => void;

export function handleMemoryBusEvent(input: {
  type: string;
  payload: Record<string, unknown>;
  memoryFacade: LocalMemoryFacade;
  emitBusEvent: LocalMemoryBusEmitter;
}): Promise<void> {
  if (input.type !== 'memory.saved') return Promise.resolve();
  const agentName = typeof input.payload.agentName === 'string' ? input.payload.agentName : '';
  // user-scope saves carry an empty agentName and have no cleanup target.
  if (!agentName.trim()) return Promise.resolve();
  return input.memoryFacade
    .triggerCleanup(agentName, false)
    .then((result) => {
      if (!result.spawned) {
        // Below-threshold / not-spawned is the common path (memory.saved fires on
        // every write); emit it anyway so "why didn't cleanup run" is answerable
        // by event rather than by absence.
        input.emitBusEvent('memory.cleanup_skipped', { agentName, ...result });
        return;
      }
      input.emitBusEvent('memory.cleanup_snapshot', { agentName, ...result });
    })
    .catch((err) => {
      input.emitBusEvent('memory.cleanup_failed', {
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export async function recordMemorySessionFinish(input: {
  session: LocalSessionRecord;
  turnId: string;
  status: LocalSessionStatus;
  errorMessage?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
  nowMs: () => number;
  memoryFacade: LocalMemoryFacade;
  emitBusEvent: LocalMemoryBusEmitter;
  publishGlobalEvent: GlobalEventPublisher;
}): Promise<void> {
  const payload = {
    sessionId: input.session.sessionId,
    agentName: input.session.agentName,
    turnId: input.turnId,
    status: input.status,
    ...(input.errorMessage ? { error: input.errorMessage } : {}),
    ...(typeof input.errorCode === 'number' ? { errorCode: input.errorCode } : {}),
    ...(input.errorSource ? { errorSource: input.errorSource } : {}),
    ...(input.errorDetail ? { errorDetail: input.errorDetail } : {}),
    ...(input.errorProviderId ? { errorProviderId: input.errorProviderId } : {}),
  };
  if (!isSessionTerminalStatus(input.status)) return;
  const result = await recordMemorySessionTerminal({
    sessionId: input.session.sessionId,
    agentName: input.session.agentName,
    turnId: input.turnId,
    status: input.status,
    ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
    nowMs: input.nowMs,
    memoryFacade: input.memoryFacade,
    emitBusEvent: input.emitBusEvent,
  });
  publishSessionTerminal(input.publishGlobalEvent, {
    ...payload,
    status: input.status,
    ...(result.date ? { date: result.date } : {}),
  });
}

/** Records terminal Memory bookkeeping without publishing Session lifecycle events. */
export async function recordMemorySessionTerminal(input: {
  sessionId: string;
  agentName: string;
  turnId: string;
  status: 'finished' | 'error' | 'aborted' | 'interrupted';
  errorMessage?: string;
  nowMs: () => number;
  memoryFacade: Pick<LocalMemoryFacade, 'markSession'>;
  emitBusEvent: LocalMemoryBusEmitter;
}): Promise<{ readonly date?: string }> {
  try {
    const agentName = input.agentName;
    if (!agentName?.trim())
      throw new LocalMemoryError('AGENT_NAME_REQUIRED', 'session has no agentName');
    const date = formatLocalDate(input.nowMs());
    await input.memoryFacade.markSession(date, input.sessionId, agentName, false);
    return { date };
  } catch (err) {
    input.emitBusEvent('memory.session_finish_failed', {
      sessionId: input.sessionId,
      agentName: input.agentName,
      turnId: input.turnId,
      status: input.status,
      ...(input.errorMessage ? { error: input.errorMessage } : {}),
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

function isSessionTerminalStatus(
  status: LocalSessionStatus,
): status is 'finished' | 'error' | 'aborted' | 'interrupted' {
  return (
    status === 'finished' || status === 'error' || status === 'aborted' || status === 'interrupted'
  );
}

function publishSessionTerminal(
  publish: GlobalEventPublisher,
  payload: {
    sessionId: string;
    agentName: string;
    turnId: string;
    status: 'finished' | 'error' | 'aborted' | 'interrupted';
    date?: string;
    error?: string;
    errorCode?: number;
    errorSource?: string;
    errorDetail?: string;
    errorProviderId?: string;
  },
): void {
  if (payload.status === 'finished') {
    publish({ type: 'session.finish', payload: { ...payload, status: payload.status } });
  } else if (payload.status === 'error') {
    publish({ type: 'session.error', payload: { ...payload, status: payload.status } });
  } else {
    publish({ type: 'session.abort', payload: { ...payload, status: payload.status } });
  }
}
