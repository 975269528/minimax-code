import type { SandboxEvalReporter, SandboxEventSink, SandboxRuntimeEvent } from './contracts.js';

/** Projection only: command/output remain on the existing tool steps. */
export function createSandboxEvalEventSink(factory?: SandboxEvalReporter): SandboxEventSink {
  return (event, delivery) => {
    if (!factory?.reportRuntimeEvent || !event.session_id) return 'unavailable';
    if (!factory.canReport()) return 'disabled';
    factory.reportRuntimeEvent(event.session_id, {
      eventType: event.event_type,
      payload: event,
      delivery,
      isError: isSandboxErrorObservation(event),
      origin: { turnId: event.turn_id ?? '', toolCallId: event.tool_call_id },
    });
    return 'queued';
  };
}

function isSandboxErrorObservation(event: SandboxRuntimeEvent): boolean {
  const payload = event.payload;
  if (event.event_type === 'sandbox.violation' || event.event_type === 'sandbox.violation_summary')
    return true;
  if (
    payload.runtime_state === 'failed' ||
    payload.result === 'failure' ||
    payload.cleanup_result === 'failure'
  )
    return true;
  if (typeof payload.violation_count === 'number' && payload.violation_count > 0) return true;
  return typeof payload.termination_kind === 'string' && payload.termination_kind !== 'exited_zero';
}
