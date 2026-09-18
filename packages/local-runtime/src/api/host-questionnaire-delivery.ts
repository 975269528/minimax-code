import { channelContextFromMessageContext } from './channel-context.js';
import type { QuestionnaireRequestRecord } from '../questionnaire/store.js';
import type { LocalChannelRunner } from '../channels/runner.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';

export interface QuestionnaireDeliveryHostHandle {
  channelRunner: LocalChannelRunner;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
  /** Optional metrics reporter injected by the host. Absent → noop. */
  metrics?: ModuleMetricsReporter;
}

export async function deliverQuestionnaireAskToChannel(
  host: QuestionnaireDeliveryHostHandle,
  record: QuestionnaireRequestRecord,
): Promise<void> {
  try {
    if (!record.originChannelContext) {
      return;
    }
    const ctx = channelContextFromMessageContext(record.originChannelContext);
    // raised = the ask targeted an IM channel; delivered = message sent.
    host.metrics?.incr('channel_ask_user_total', { channel: ctx.platform, phase: 'raised' });
    const client = host.channelRunner.clients.get(ctx);
    if (!client?.sendMessage) return;
    await client.sendMessage({
      ctx,
      text: record.request.title ?? record.request.steps[0]?.question ?? '',
      questionnaire: record.request,
      sessionId: record.sessionId,
    });
    host.metrics?.incr('channel_ask_user_total', { channel: ctx.platform, phase: 'delivered' });
  } catch (err) {
    host.emitBusEvent('questionnaire.delivery_failed', {
      requestId: record.requestId,
      sessionId: record.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
