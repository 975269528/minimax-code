import {
  RuntimeEventType,
  type IRuntimeEvent,
  type IRuntimeStopReason,
  type RuntimeEventStatus,
} from '@mavis/protocol';

export interface LocalRuntimeStreamRespFrame {
  kind: 'stream.resp';
  eventId: string;
  sessionId: string;
  turnId?: string;
  runtimeSeq?: number;
  /**
   * Browser-facing payload body. This is the same flat RespData JSON string
   * archon-server writes as `data: <RespData JSON>` after unwrapping cloud
   * RuntimeEvent envelopes.
   */
  data: string;
}

export interface LocalRuntimeSessionStatusFrame {
  kind: 'session.status';
  eventId: string;
  sessionId: string;
  turnId?: string;
  status?: RuntimeEventStatus;
  stopReason?: IRuntimeStopReason;
  event: IRuntimeEvent;
}

export interface LocalRuntimeTurnTerminalFrame {
  kind: 'turn.terminal';
  eventId: string;
  sessionId: string;
  turnId?: string;
  runtimeSeq?: number;
  status?: RuntimeEventStatus;
  stopReason?: IRuntimeStopReason;
  event: IRuntimeEvent;
}

export interface LocalRuntimeGenericFrame {
  kind: 'runtime.event';
  eventId: string;
  sessionId: string;
  turnId?: string;
  runtimeSeq?: number;
  event: IRuntimeEvent;
}

export type LocalRuntimeProjectionFrame =
  | LocalRuntimeStreamRespFrame
  | LocalRuntimeSessionStatusFrame
  | LocalRuntimeTurnTerminalFrame
  | LocalRuntimeGenericFrame;

export function projectLocalRuntimeEvent(event: IRuntimeEvent): LocalRuntimeProjectionFrame | null {
  if (event.type === RuntimeEventType.STREAM_RESP) {
    const streamResp = event.payload?.stream_resp;
    if (typeof streamResp !== 'string' || streamResp.length === 0) return null;
    return {
      kind: 'stream.resp',
      eventId: event.event_id,
      sessionId: event.session_id,
      ...(event.turn_id ? { turnId: event.turn_id } : {}),
      ...(typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {}),
      data: streamResp,
    };
  }

  if (event.type === RuntimeEventType.SESSION_STATUS) {
    return {
      kind: 'session.status',
      eventId: event.event_id,
      sessionId: event.session_id,
      ...(event.turn_id ? { turnId: event.turn_id } : {}),
      ...(event.payload?.status !== undefined ? { status: event.payload.status } : {}),
      ...(event.payload?.stop_reason !== undefined
        ? { stopReason: event.payload.stop_reason }
        : {}),
      event,
    };
  }

  if (event.type === RuntimeEventType.TURN_TERMINAL) {
    return {
      kind: 'turn.terminal',
      eventId: event.event_id,
      sessionId: event.session_id,
      ...(event.turn_id ? { turnId: event.turn_id } : {}),
      ...(typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {}),
      ...(event.payload?.status !== undefined ? { status: event.payload.status } : {}),
      ...(event.payload?.stop_reason !== undefined
        ? { stopReason: event.payload.stop_reason }
        : {}),
      event,
    };
  }

  return {
    kind: 'runtime.event',
    eventId: event.event_id,
    sessionId: event.session_id,
    ...(event.turn_id ? { turnId: event.turn_id } : {}),
    ...(typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {}),
    event,
  };
}

export function projectLocalRuntimeEvents(
  events: readonly IRuntimeEvent[],
): LocalRuntimeProjectionFrame[] {
  const frames: LocalRuntimeProjectionFrame[] = [];
  for (const event of events) {
    const frame = projectLocalRuntimeEvent(event);
    if (frame) frames.push(frame);
  }
  return frames;
}
