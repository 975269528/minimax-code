import type { CommittedQueueCapability } from '../session-system/index.js';
import { INTERNAL_TURN_ID_PREFIX } from '@mavis/shared/turn-identity';

const PLAN_CONTINUATION_IDENTITY_PREFIXES = [
  `${INTERNAL_TURN_ID_PREFIX}plan-enter:`,
  `${INTERNAL_TURN_ID_PREFIX}plan-review:`,
  `${INTERNAL_TURN_ID_PREFIX}plan-review-feedback:`,
  'plan-enter:',
  'plan-review:',
  'plan-review-feedback:',
] as const;

export async function recoverPlanLifecycleAndImplementationQueue(options: {
  readonly dispatch: boolean;
  readonly recoverLifecycle: () => Promise<number>;
  readonly recoverImplementationQueue: () => Promise<void>;
}): Promise<number> {
  let completed = 0;
  const failures: unknown[] = [];
  try {
    completed = await options.recoverLifecycle();
  } catch (error) {
    failures.push(error);
  }
  if (options.dispatch) {
    try {
      await options.recoverImplementationQueue();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Plan lifecycle recovery was incomplete');
  }
  return completed;
}

export async function recoverPlanImplementationQueue(options: {
  readonly queue: Pick<CommittedQueueCapability, 'listPendingSessionIds' | 'list' | 'cancel'>;
  readonly dispatchQueue: (sessionId: string) => Promise<void>;
  readonly entryEnabled: () => boolean;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const sessionId of await options.queue.listPendingSessionIds()) {
    try {
      await recoverPlanImplementationQueueSession(options, sessionId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, 'Approved Plan implementation Queue recovery was incomplete');
  }
}

async function recoverPlanImplementationQueueSession(
  options: {
    readonly queue: Pick<CommittedQueueCapability, 'list' | 'cancel'>;
    readonly dispatchQueue: (sessionId: string) => Promise<void>;
    readonly entryEnabled: () => boolean;
  },
  sessionId: string,
): Promise<void> {
  const items = await options.queue.list(sessionId);
  if (!options.entryEnabled()) {
    await cancelQueuedPlanEntries(options.queue, sessionId, items);
  }
  if (items.some(isApprovedPlanImplementation)) {
    await options.dispatchQueue(sessionId);
  }
}

async function cancelQueuedPlanEntries(
  queue: Pick<CommittedQueueCapability, 'cancel'>,
  sessionId: string,
  items: Awaited<ReturnType<CommittedQueueCapability['list']>>,
): Promise<void> {
  for (const item of items) {
    if (item.message.clientIntent !== 'plan-entry') continue;
    const cancelled = await queue.cancel(sessionId, item.itemId);
    if (cancelled === 'not_editable') {
      throw new Error(
        `Plan entry Queue item could not be cancelled during gate-off recovery: ${sessionId}/${item.itemId}`,
      );
    }
  }
}

function isApprovedPlanImplementation(item: {
  readonly source: string;
  readonly clientRequestId?: string;
  readonly requestedTurnId?: string;
}): boolean {
  const identity = item.clientRequestId;
  return (
    item.source === 'questionnaire' &&
    identity !== undefined &&
    isPlanContinuationIdentity(identity) &&
    item.requestedTurnId === identity
  );
}

function isPlanContinuationIdentity(identity: string): boolean {
  return PLAN_CONTINUATION_IDENTITY_PREFIXES.some(
    (prefix) => identity.length > prefix.length && identity.startsWith(prefix),
  );
}
