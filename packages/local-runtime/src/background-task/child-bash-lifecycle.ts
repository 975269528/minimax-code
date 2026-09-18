import { isTerminalTaskStatus, type BackgroundTask } from './domain.js';
import type { LocalBackgroundTaskService } from './service.js';
import { taskWaitAbortError, type TaskWaiterRegistry } from './task-waiter-registry.js';
import { buildBackgroundTaskDeliveryPrompt } from './conversation-delivery.js';

type ChildBashService = Pick<LocalBackgroundTaskService, 'list' | 'stop' | 'waitForTaskChange'>;

/** A child Turn owns its Bash continuations; terminal events must never start a new child Turn. */
export function createChildBashLifecycle(
  service: ChildBashService,
  input: { readonly sessionId: string; readonly turnId: string; readonly signal: AbortSignal },
) {
  const notified = new Set<string>();
  const listOwned = async (): Promise<BackgroundTask[]> => {
    const tasks: BackgroundTask[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list({
        ownerSessionId: input.sessionId,
        kinds: ['bash'],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      tasks.push(...page.items.filter((task) => task.metadata?.parentTurnId === input.turnId));
      cursor = page.nextCursor;
    } while (cursor);
    return tasks;
  };
  return {
    async hasPending() {
      return (await listOwned()).some((task) => !isTerminalTaskStatus(task.status));
    },
    async poll(options: {
      readonly wait: boolean;
      readonly readTaskIds: ReadonlySet<string>;
      readonly steeringSignal?: AbortSignal;
    }) {
      const signal = options.steeringSignal
        ? AbortSignal.any([input.signal, options.steeringSignal])
        : input.signal;
      for (;;) {
        if (input.signal.aborted) throw taskWaitAbortError(input.signal);
        if (options.steeringSignal?.aborted) return undefined;
        const tasks = await listOwned();
        const unread = tasks.filter(
          (task) =>
            isTerminalTaskStatus(task.status) &&
            task.deliveredAt === undefined &&
            !notified.has(task.taskId) &&
            !options.readTaskIds.has(task.taskId),
        );
        if (unread.length > 0) {
          for (const task of unread) notified.add(task.taskId);
          return buildBackgroundTaskDeliveryPrompt(unread);
        }
        const pending = tasks.filter((task) => !isTerminalTaskStatus(task.status));
        if (!options.wait || pending.length === 0) return undefined;
        // No model polling and no new Turn: keep the accepted child lease until its Bash settles.
        try {
          await service.waitForTaskChange(
            input.sessionId,
            pending.map((task) => task.taskId),
            signal,
          );
        } catch (error) {
          if (input.signal.aborted) throw taskWaitAbortError(input.signal);
          if (options.steeringSignal?.aborted) return undefined;
          throw error;
        }
      }
    },
    async close() {
      const pending = (await listOwned()).filter((task) => !isTerminalTaskStatus(task.status));
      const results = await Promise.allSettled(
        pending.map((task) => service.stop(task.taskId, 'Owning child Turn ended')),
      );
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length > 0)
        throw new AggregateError(failures, 'Failed to stop child Bash tasks');
    },
  };
}

/** Register first, then read durable state: a completion racing admission cannot be missed. */
export async function waitForChildBashTaskChange(
  waiters: TaskWaiterRegistry,
  input: { ownerSessionId: string; taskIds: readonly string[]; signal: AbortSignal },
  getTask: (taskId: string) => Promise<BackgroundTask | undefined>,
): Promise<void> {
  if (input.signal.aborted) throw taskWaitAbortError(input.signal);
  const waiter = waiters.create(`session:${input.ownerSessionId}`, input.signal);
  try {
    const tasks = await Promise.all(input.taskIds.map(getTask));
    if (
      tasks.some(
        (task) =>
          !task ||
          task.ownerSessionId !== input.ownerSessionId ||
          isTerminalTaskStatus(task.status),
      )
    )
      return;
    await waiter.wait(30_000);
  } finally {
    waiter.cancel();
  }
}
