import type { IRuntimeEvent } from '@mavis/protocol';
import type { RespData } from '@mavis/agent-core/protocol/agent-message';

/**
 * Pending event queue entry.
 *
 * This interface and parseStreamResp helper live separately to keep output-safety-writer.ts within
 * the layout gate's default 500-line budget (see scripts/check-local-runtime-layout.mjs).
 */
export interface PendingEvent {
  /** Original runtime event, written unchanged to the inner writer when actually flushed. */
  event: IRuntimeEvent;
  /** Whether review has passed or is unnecessary; release only consecutive true entries at the queue head. */
  releasable: boolean;
}

/**
 * Parse a stream_resp payload string into RespData. Return undefined on parse failure; callers
 * treat it as having no reviewable text but still enqueue it in producer order.
 */
export function parseStreamResp(event: IRuntimeEvent): RespData | undefined {
  const raw = event.payload?.stream_resp;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as RespData;
  } catch {
    return undefined;
  }
}
