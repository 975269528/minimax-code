import type { LocalEvalReporterFactoryLike, LocalEvalRuntimeEventDelivery } from '../eval/types.js';
import type { ThreadGoalRuntimeEvent, ThreadGoalRuntimeEventSink } from './events.js';

const GOAL_RUNTIME_EVENT_SCHEMA = 'mavis.goal_runtime_event.v1';

/** Projects Goal decisions into the existing Session Clio lifecycle stream. */
export function createThreadGoalEvalEventSink(
  reporterFactory: LocalEvalReporterFactoryLike,
): ThreadGoalRuntimeEventSink {
  return (event) => void reportThreadGoalEvalEvent(reporterFactory, event);
}

export interface ThreadGoalEvalEventDelivery {
  readonly sessionId: string;
  readonly trajectory: 'parent' | 'verifier_child';
  readonly outcome: LocalEvalRuntimeEventDelivery | 'unsupported' | 'projection_failed';
}

export function reportThreadGoalEvalEvent(
  reporterFactory: LocalEvalReporterFactoryLike,
  event: ThreadGoalRuntimeEvent,
): ThreadGoalEvalEventDelivery[] {
  const input = {
    eventType: event.type,
    payload: {
      schema: GOAL_RUNTIME_EVENT_SCHEMA,
      event_type: event.type,
      event_at_ms: event.at,
      payload: snakeCaseObject(event.payload),
    },
  };
  const deliveries: ThreadGoalEvalEventDelivery[] = [
    {
      sessionId: event.payload.sessionId,
      trajectory: 'parent',
      outcome: reportRuntimeEvent(reporterFactory, event.payload.sessionId, input),
    },
  ];

  const childSessionId = verifierChildSessionId(event);
  if (childSessionId && childSessionId !== event.payload.sessionId) {
    deliveries.push({
      sessionId: childSessionId,
      trajectory: 'verifier_child',
      outcome: reportRuntimeEvent(reporterFactory, childSessionId, input),
    });
  }
  return deliveries;
}

function reportRuntimeEvent(
  reporterFactory: LocalEvalReporterFactoryLike,
  sessionId: string,
  input: Parameters<NonNullable<LocalEvalReporterFactoryLike['reportRuntimeEvent']>>[1],
): ThreadGoalEvalEventDelivery['outcome'] {
  try {
    return reporterFactory.reportRuntimeEvent?.(sessionId, input) ?? 'unsupported';
  } catch {
    // Local structured observability must survive a broken optional Clio adapter.
    return 'projection_failed';
  }
}

function verifierChildSessionId(event: ThreadGoalRuntimeEvent): string | undefined {
  if (
    event.type !== 'goal.verification_child_started' &&
    event.type !== 'goal.verification_decided'
  ) {
    return undefined;
  }
  return event.payload.childSessionId;
}

function snakeCaseObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseObject);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [toSnakeCase(key), snakeCaseObject(nested)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toSnakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
