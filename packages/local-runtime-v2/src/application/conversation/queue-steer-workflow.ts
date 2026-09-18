import { RuntimeEventStatus, RuntimeEventType } from '@mavis/agent-core/protocol';

import {
  QueueServiceError,
  type SessionFrame,
  type SessionStreamReservation,
  type SessionStreamService,
  type CommittedQueueCapability,
  type QueueDispatchClaim,
  type QueueItem,
} from '../../service/session-system/index.js';
import type {
  QueueSteerControl,
  SteerSessionResult,
  TurnService,
} from '../../service/turn-system/index.js';
import { queueClaimDeliveryInput } from '../../service/turn-system/index.js';
import { ApplicationError } from './errors.js';
import { queueServiceApplicationError } from './queue-service-error.js';

export interface QueueSteerInput {
  readonly sessionId: string;
  readonly queueItemId?: string;
}

export interface QueueSteerResult {
  readonly queueItemId: string;
  readonly turnId: string;
}

const QUEUE_IMMEDIATE_SEND_PRODUCER = 'queue-immediate-send';

export interface QueueSteerWorkflowOptions {
  readonly queue: Pick<
    CommittedQueueCapability,
    'requireMutableSession' | 'list' | 'get' | 'continueQueue'
  >;
  readonly turn: Pick<TurnService, 'steer'>;
  readonly control: QueueSteerControl;
  readonly stream: Pick<SessionStreamService, 'reserve'>;
  readonly activation: {
    prepareForUserActivation(sessionId: string): Promise<unknown>;
  };
}

/** Application workflow steering the claimed Queue head into the active Turn. */
export class QueueSteerWorkflow {
  constructor(private readonly options: QueueSteerWorkflowOptions) {}

  async execute(input: QueueSteerInput): Promise<QueueSteerResult> {
    await this.invokeQueue(() => this.options.queue.requireMutableSession(input.sessionId));
    const selected = await this.requireQueuedItem(input);
    const claim = await this.claimSelected(input.sessionId, selected.itemId);
    const reservation = this.options.stream.reserve(input.sessionId);
    const state = { consumed: false };
    try {
      const result = await this.steerClaim(claim, reservation, state);
      if (claim.message.clientIntent !== 'cloud-handoff') await this.endQueuePause(input.sessionId);
      if (!state.consumed) await this.consumeClaim(claim, result);
      if (result.mode === 'activated') await waitForTurnVisibility(reservation.source);
      return { queueItemId: claim.item.itemId, turnId: result.turnId };
    } finally {
      reservation.close();
    }
  }

  /**
   * Settles the claimed item after a durably delivered steer. When the active
   * Turn hits the exit boundary before this settles, the steering requeue
   * takes the item identity over and deletes the claimed row first; that
   * vanished claim is settled work, not an error. A claim that resurfaced as
   * the original queued row is real trouble and keeps throwing.
   */
  private async consumeClaim(
    claim: QueueDispatchClaim,
    result: Extract<SteerSessionResult, { readonly delivered: true }>,
  ): Promise<void> {
    try {
      await this.options.control.consume(claim, consumeOutcome(result));
    } catch (error) {
      const survivor = await this.invokeQueue(() =>
        this.options.queue.get(claim.sessionId, claim.item.itemId),
      );
      const transferred = survivor?.immediateSendBatch?.members.some(
        (member) =>
          (member.queueClaim?.itemId === claim.item.itemId &&
            member.queueClaim.claimId === claim.claimId) ||
          (member.sourceMessageId === claim.item.itemId &&
            member.messageKey === `steer:${QUEUE_IMMEDIATE_SEND_PRODUCER}:${claim.claimId}`),
      );
      if (survivor && survivor.createdAt === claim.item.createdAt && !transferred) throw error;
    }
  }

  private async steerClaim(
    claim: QueueDispatchClaim,
    reservation: SessionStreamReservation,
    state: { consumed: boolean },
  ): Promise<Extract<SteerSessionResult, { readonly delivered: true }>> {
    const request = this.steerRequest(claim, reservation, state);
    let result: SteerSessionResult;
    try {
      result = await this.options.turn.steer(request);
    } catch (error) {
      await this.options.control.release(claim);
      throw error;
    }
    if (!result.delivered) {
      await this.options.control.release(claim);
      throw new ApplicationError(
        409,
        'local_queue_dispatch_rejected',
        `Queue item could not start (${result.reason}): ${claim.sessionId}/${claim.item.itemId}`,
      );
    }
    return result;
  }

  private steerRequest(
    claim: QueueDispatchClaim,
    reservation: SessionStreamReservation,
    state: { consumed: boolean },
  ): Parameters<TurnService['steer']>[0] {
    const delivery = queueClaimDeliveryInput(claim);
    return {
      sessionId: claim.sessionId,
      input: delivery.input,
      ...(claim.item.immediateSendBatch
        ? { immediateSendBatch: claim.item.immediateSendBatch }
        : {}),
      createdAt: claim.item.createdAt,
      provenance: delivery.ingress.provenance,
      producerId: QUEUE_IMMEDIATE_SEND_PRODUCER,
      // The idempotency domain is one claim, not the item's lifetime: a
      // requeued item restores its id, and a later send-now must be a fresh
      // delivery instead of replaying the old receipt as a duplicate that
      // consumes the item without any Turn reading it.
      idempotencyKey: claim.claimId,
      modelSelectionScope: 'activation-only',
      admissionPriority: { kind: 'selected-queue-item', queueClaimId: claim.claimId },
      ...(delivery.ingress.provenance.source === 'api' ||
      delivery.ingress.provenance.source === 'code_review'
        ? { sourceMessageId: claim.item.itemId }
        : {}),
      ...(delivery.inputSafetyDecision
        ? { inputSafetyDecision: delivery.inputSafetyDecision }
        : {}),
      ...(delivery.userMessageId ? { userMessageId: delivery.userMessageId } : {}),
      ...(delivery.requestedTurnId ? { requestedTurnId: delivery.requestedTurnId } : {}),
      ...(delivery.clientIntent ? { clientIntent: delivery.clientIntent } : {}),
      delivery: this.steerDeliveryOptions(claim, delivery, state),
      preDelivery: {
        accept: async ({ mode, turnId }) => {
          if (mode !== 'activated') return;
          reservation.bindTurn(turnId);
        },
      },
    };
  }

  private steerDeliveryOptions(
    claim: QueueDispatchClaim,
    delivery: ReturnType<typeof queueClaimDeliveryInput>,
    state: { consumed: boolean },
  ): Parameters<TurnService['steer']>[0]['delivery'] {
    let accepted: Parameters<QueueSteerControl['observe']>[1] | undefined;
    return {
      propagateDeliveryFailure: true,
      unstartedFromTurnIds: delivery.unstartedFromTurnIds,
      beforeSubmit: (turnId) => this.options.control.prepareDelivery(claim, turnId),
      onAccepted: (result) => {
        accepted = result;
        this.options.control.observe(claim, result);
      },
      ...(delivery.hideUserMessage !== undefined
        ? { hideUserMessage: delivery.hideUserMessage }
        : {}),
      ...(delivery.displayContent !== undefined ? { displayContent: delivery.displayContent } : {}),
      ...(delivery.displayAttachments ? { displayAttachments: delivery.displayAttachments } : {}),
      beforeStart: async () => {
        await this.options.activation.prepareForUserActivation(claim.sessionId);
        if (!accepted) throw new Error('Queue delivery has no accepted Turn');
        await this.consumeClaim(claim, {
          delivered: true,
          mode: 'activated',
          turnId: accepted.turnId,
          completion: accepted.completion,
        });
        state.consumed = true;
      },
    };
  }

  private async claimSelected(sessionId: string, itemId: string): Promise<QueueDispatchClaim> {
    const claim = await this.options.control.claim({ sessionId, itemId });
    if (claim) return claim;
    const current = await this.invokeQueue(() => this.options.queue.get(sessionId, itemId));
    if (!current) throw queueItemNotFound(sessionId, itemId);
    throw queueItemClaimed(sessionId, itemId);
  }

  private async requireQueuedItem(input: QueueSteerInput): Promise<QueueItem> {
    const queueItemId = input.queueItemId;
    const item = queueItemId
      ? await this.invokeQueue(() => this.options.queue.get(input.sessionId, queueItemId))
      : (await this.invokeQueue(() => this.options.queue.list(input.sessionId)))[0];
    if (!item) throw queueItemNotFound(input.sessionId, queueItemId);
    if (item.status !== 'queued') throw queueItemClaimed(input.sessionId, item.itemId);
    return item;
  }

  /**
   * Steer is the explicit user command that ends QueuePaused, so the remaining items drain
   * normally once the joined or activated Turn releases.
   *
   * Called only after steer admission succeeds: a Steer that was never admitted must leave the
   * Queue guarded. At that point the message is already delivered, so this is best-effort — a
   * failing cleanup must not report an accepted Steer as failed, or the client would raise an
   * error and the user could steer the same item twice. A failure simply leaves QueuePaused in
   * place, which is the guarded direction, and the next explicit Continue retries this path.
   */
  private async endQueuePause(sessionId: string): Promise<void> {
    try {
      await this.options.queue.continueQueue(sessionId);
    } catch {
      // Intentionally ignored; see the contract above.
    }
  }

  private async invokeQueue<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QueueServiceError) throw queueServiceApplicationError(error);
      throw error;
    }
  }
}

function consumeOutcome(
  result: Extract<SteerSessionResult, { readonly delivered: true }>,
): Parameters<QueueSteerControl['consume']>[1] {
  return result.mode === 'activated'
    ? { mode: 'activated', turnId: result.turnId, completion: result.completion }
    : { mode: result.mode, turnId: result.turnId };
}

async function waitForTurnVisibility(source: AsyncIterableIterator<SessionFrame>): Promise<void> {
  for (;;) {
    const next = await source.next();
    if (next.done) throw new Error('Queue Steer Turn stream closed before start');
    if (isStartedOrTerminalFrame(next.value)) return;
  }
}

function isStartedOrTerminalFrame(frame: SessionFrame): boolean {
  if (frame.kind === 'turn-terminal') return true;
  if (frame.kind !== 'runtime-event' || !isRecord(frame.data)) return false;
  const payload = frame.data['payload'];
  return (
    frame.data['type'] === RuntimeEventType.SESSION_STATUS &&
    isRecord(payload) &&
    payload['status'] === RuntimeEventStatus.RUNNING
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queueItemNotFound(sessionId: string, queueItemId?: string): ApplicationError {
  return new ApplicationError(
    404,
    'local_queue_item_not_found',
    queueItemId
      ? `Queue item not found: ${sessionId}/${queueItemId}`
      : `No queued item is available: ${sessionId}`,
  );
}

function queueItemClaimed(sessionId: string, queueItemId: string): ApplicationError {
  return new ApplicationError(
    409,
    'local_queue_item_claimed',
    `Queue item is already being dispatched: ${sessionId}/${queueItemId}`,
  );
}
