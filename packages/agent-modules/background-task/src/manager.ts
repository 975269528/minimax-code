import {
  TaskNotFoundError,
  TaskRunnerAlreadyRegisteredError,
  TaskRunnerNotFoundError,
  normalizeTaskError,
} from './errors.js';
import { createBackgroundTaskId, createTaskLifecycleEventId, type IdGenerator } from './id.js';
import { isTerminalTaskStatus } from './status.js';
import type {
  BackgroundTask,
  BackgroundTaskKind,
  BackgroundTaskPatch,
  BackgroundTaskManager,
  CompleteTaskOptions,
  StartTaskRequest,
  TaskLifecycleEvent,
  TaskLifecycleEventType,
  TaskListResult,
  TaskOutputReadOptions,
  TaskOutputReadResult,
  TaskOutputStore,
  TaskQuery,
  TaskRunner,
  TaskStore,
} from './types.js';

export interface DefaultBackgroundTaskManagerOptions {
  store: TaskStore;
  outputStore: TaskOutputStore;
  runners?: Iterable<TaskRunner>;
  now?: () => number;
  taskIdGenerator?: IdGenerator;
  eventIdGenerator?: IdGenerator;
}

export class DefaultBackgroundTaskManager implements BackgroundTaskManager {
  private readonly store: TaskStore;
  private readonly outputStore: TaskOutputStore;
  private readonly runners = new Map<BackgroundTaskKind, TaskRunner>();
  private readonly now: () => number;
  private readonly taskIdGenerator: IdGenerator;
  private readonly eventIdGenerator: IdGenerator;
  private sequence = 0;

  constructor(options: DefaultBackgroundTaskManagerOptions) {
    this.store = options.store;
    this.outputStore = options.outputStore;
    this.now = options.now ?? Date.now;
    this.taskIdGenerator = options.taskIdGenerator ?? createBackgroundTaskId;
    this.eventIdGenerator = options.eventIdGenerator ?? createTaskLifecycleEventId;

    for (const runner of options.runners ?? []) {
      this.registerRunner(runner);
    }
  }

  registerRunner<TInput>(runner: TaskRunner<TInput>): void {
    if (this.runners.has(runner.kind)) {
      throw new TaskRunnerAlreadyRegisteredError(runner.kind);
    }
    this.runners.set(runner.kind, runner as TaskRunner);
  }

  async start<TInput>(request: StartTaskRequest<TInput>): Promise<BackgroundTask> {
    const runner = this.getRunner(request.kind);
    const now = this.now();
    const task: BackgroundTask = {
      taskId: this.taskIdGenerator(),
      kind: request.kind,
      status: 'queued',
      ownerSessionId: request.ownerSessionId,
      description: request.description,
      toolCallId: request.toolCallId,
      parentMessageId: request.parentMessageId,
      parentTaskId: request.parentTaskId,
      createdAt: now,
      updatedAt: now,
      metadata: request.metadata ? { ...request.metadata } : undefined,
    };

    const created = await this.store.create(task);
    await this.emit(created, 'created', { inputKind: request.kind });

    try {
      const handle = await runner.start(created, request.input);
      const startedPatch: BackgroundTaskPatch = {
        status: 'running',
        startedAt: this.now(),
      };
      if (handle.outputRef) startedPatch.outputRef = handle.outputRef;

      const started = await this.store.patch(created.taskId, startedPatch);
      await this.emit(started, 'started', {
        hasOutputRef: Boolean(handle.outputRef),
      });
      return started;
    } catch (error) {
      const failed = await this.store.patch(created.taskId, {
        status: 'failed',
        endedAt: this.now(),
        lastError: normalizeTaskError(error, 'TASK_START_FAILED'),
      });
      await this.emit(failed, 'completed', { status: 'failed' });
      return failed;
    }
  }

  async get(taskId: string): Promise<BackgroundTask | undefined> {
    return this.store.get(taskId);
  }

  async list(query: TaskQuery): Promise<TaskListResult> {
    return this.store.list(query);
  }

  async readOutput(taskId: string, options?: TaskOutputReadOptions): Promise<TaskOutputReadResult> {
    return this.outputStore.read(taskId, options);
  }

  async stop(taskId: string, reason?: string): Promise<BackgroundTask> {
    const task = await this.requireTask(taskId);
    if (isTerminalTaskStatus(task.status)) return task;
    if (task.status === 'stopping') return task;

    const stopping = await this.store.patch(taskId, { status: 'stopping' });
    await this.emit(stopping, 'stop_requested', { reason });

    try {
      await this.getRunner(task.kind).stop(taskId, reason);
      const canceledPatch: BackgroundTaskPatch = {
        status: 'canceled',
        endedAt: this.now(),
      };
      if (reason) canceledPatch.lastError = { message: reason, code: 'TASK_CANCELED' };

      const canceled = await this.store.patch(taskId, canceledPatch);
      await this.emit(canceled, 'completed', { status: 'canceled' });
      return canceled;
    } catch (error) {
      const canceled = await this.store.patch(taskId, {
        status: 'canceled',
        endedAt: this.now(),
        lastError: normalizeTaskError(error, 'TASK_STOP_FAILED'),
      });
      await this.emit(canceled, 'completed', { status: 'canceled', stopFailed: true });
      return canceled;
    }
  }

  async complete(taskId: string, options: CompleteTaskOptions = {}): Promise<BackgroundTask> {
    const task = await this.requireTask(taskId);
    if (isTerminalTaskStatus(task.status)) return task;

    if (options.summary !== undefined) {
      await this.outputStore.finalize(taskId, options.summary);
    }

    const completedPatch: BackgroundTaskPatch = {
      status: options.status ?? 'succeeded',
      endedAt: this.now(),
    };
    if (options.outputRef) completedPatch.outputRef = options.outputRef;
    if (options.usage) completedPatch.usage = options.usage;
    if (options.metadata) completedPatch.metadata = options.metadata;

    const completed = await this.store.patch(taskId, completedPatch);
    await this.emit(completed, 'completed', { status: completed.status });
    return completed;
  }

  async fail(taskId: string, error: unknown): Promise<BackgroundTask> {
    const task = await this.requireTask(taskId);
    if (isTerminalTaskStatus(task.status)) return task;

    const failed = await this.store.patch(taskId, {
      status: 'failed',
      endedAt: this.now(),
      lastError: normalizeTaskError(error),
    });
    await this.emit(failed, 'completed', { status: 'failed' });
    return failed;
  }

  private getRunner(kind: BackgroundTaskKind): TaskRunner {
    const runner = this.runners.get(kind);
    if (!runner) throw new TaskRunnerNotFoundError(kind);
    return runner;
  }

  private async requireTask(taskId: string): Promise<BackgroundTask> {
    const task = await this.store.get(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }

  private async emit(
    task: BackgroundTask,
    type: TaskLifecycleEventType,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const event: TaskLifecycleEvent = {
      eventId: this.eventIdGenerator(),
      taskId: task.taskId,
      ownerSessionId: task.ownerSessionId,
      type,
      timestamp: this.now(),
      sequence: ++this.sequence,
      payload,
    };
    await this.store.appendEvent(event);
  }
}
