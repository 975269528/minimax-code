import type { CronDeliveryRequest, CronDeliveryResult, CronTurnDeliveryPort } from './contracts.js';
import type { TurnService } from '../turn-system/index.js';

type ReportDeliveryFailure = (sessionId: string, message: string) => void;

function createRuntimeCronTurnDelivery(
  turns: Pick<TurnService, 'steer'>,
  reportFailure: ReportDeliveryFailure | undefined,
): CronTurnDeliveryPort {
  return {
    deliver: (request) => deliverRuntimeCron(turns, request, reportFailure),
  };
}

export function createOptionalRuntimeCronTurnDelivery(
  cronEnabled: boolean,
  override: CronTurnDeliveryPort | undefined,
  turns: Pick<TurnService, 'steer'>,
  reportFailure: ReportDeliveryFailure | undefined,
): CronTurnDeliveryPort | undefined {
  return cronEnabled
    ? (override ?? createRuntimeCronTurnDelivery(turns, reportFailure))
    : undefined;
}

export async function deliverRuntimeCron(
  turns: Pick<TurnService, 'steer'>,
  request: Pick<CronDeliveryRequest, 'cronId' | 'runId' | 'sessionId' | 'text'>,
  reportFailure: ReportDeliveryFailure | undefined,
): Promise<CronDeliveryResult> {
  const result = await turns.steer({
    sessionId: request.sessionId,
    input: { text: request.text },
    producerId: `cron:${request.cronId}`,
    idempotencyKey: request.runId,
    provenance: {
      source: 'cron',
      routingFingerprint: `cron:${request.cronId}:${request.runId}`,
      sourceContext: { cronId: request.cronId, runId: request.runId },
    },
  });
  if (result.delivered) return { delivered: true };
  const errorCode = `CRON_DELIVERY_${result.reason.toUpperCase().replaceAll('-', '_')}`;
  reportFailure?.(request.sessionId, errorCode);
  return {
    delivered: false,
    errorCode,
    error: `Cron steer delivery was rejected: ${result.reason}`,
  };
}
