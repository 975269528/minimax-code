/**
 * `@mavis/background-task` —— shared background task domain.
 *
 * This package is IO-free by design. It defines the cross-runtime task
 * vocabulary, lifecycle contracts, state helpers, and small in-memory
 * implementations for tests/adapters. Cloud and desktop runtimes provide
 * their own TaskStore, TaskOutputStore, and TaskRunner implementations.
 */

export type {
  BackgroundTaskKind,
  BackgroundTaskStatus,
  BackgroundTask,
  BackgroundTaskPatch,
  BackgroundTaskController,
  BackgroundTaskManager,
  CompleteTaskOptions,
  StartTaskRequest,
  TaskError,
  TaskLivenessModel,
  TaskLivenessResult,
  TaskLivenessState,
  TaskLifecycleEvent,
  TaskLifecycleEventType,
  TaskListResult,
  TaskOutputChunk,
  TaskOutputKind,
  TaskOutputReadOptions,
  TaskOutputReadResult,
  TaskOutputRef,
  TaskOutputStore,
  TaskOutputStream,
  TaskQuery,
  TaskRunner,
  TaskRuntimeHandle,
  TaskStore,
  TaskUsage,
} from './types.js';

export {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  canTransitionTaskStatus,
  isActiveTaskStatus,
  isTerminalTaskStatus,
} from './status.js';

export {
  BackgroundTaskError,
  InvalidTaskStatusTransitionError,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  TaskRunnerAlreadyRegisteredError,
  TaskRunnerNotFoundError,
  normalizeTaskError,
} from './errors.js';

export { createBackgroundTaskId, createTaskLifecycleEventId, type IdGenerator } from './id.js';

export { DefaultBackgroundTaskManager } from './manager.js';
export type { DefaultBackgroundTaskManagerOptions } from './manager.js';
export { InMemoryTaskStore } from './in-memory-store.js';
export type { InMemoryTaskStoreOptions } from './in-memory-store.js';
export { InMemoryTaskOutputStore } from './in-memory-output-store.js';
export type { InMemoryTaskOutputStoreOptions } from './in-memory-output-store.js';
