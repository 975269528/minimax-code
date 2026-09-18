export interface TaskWaiter {
  wait(timeoutMs: number): Promise<'event' | 'timeout'>;
  cancel(): void;
}

export class TaskWaiterRegistry {
  private readonly waiters = new Map<string, Set<() => void>>();

  create(taskId: string, signal?: AbortSignal): TaskWaiter {
    let notified = false;
    let settleEvent: (() => void) | undefined;
    const wake = () => {
      notified = true;
      settleEvent?.();
    };
    const taskWaiters = this.waiters.get(taskId) ?? new Set<() => void>();
    taskWaiters.add(wake);
    this.waiters.set(taskId, taskWaiters);

    let canceled = false;
    const cancel = () => {
      if (canceled) return;
      canceled = true;
      taskWaiters.delete(wake);
      if (taskWaiters.size === 0 && this.waiters.get(taskId) === taskWaiters) {
        this.waiters.delete(taskId);
      }
    };
    const wait = (timeoutMs: number): Promise<'event' | 'timeout'> => {
      if (notified) return Promise.resolve('event');
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          cancel();
          reject(taskWaitAbortError(signal));
          return;
        }
        const finish = (outcome: 'event' | 'timeout') => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          settleEvent = undefined;
          resolve(outcome);
        };
        const timer = setTimeout(() => finish('timeout'), timeoutMs);
        timer.unref?.();
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          settleEvent = undefined;
          cancel();
          reject(taskWaitAbortError(signal));
        };
        settleEvent = () => finish('event');
        signal?.addEventListener('abort', onAbort, { once: true });
        if (notified) settleEvent();
      });
    };
    return { wait, cancel };
  }

  notify(taskId: string): void {
    const taskWaiters = this.waiters.get(taskId);
    if (!taskWaiters) return;
    this.waiters.delete(taskId);
    for (const wake of taskWaiters) wake();
  }
}

export function taskWaitAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Operation aborted');
}
