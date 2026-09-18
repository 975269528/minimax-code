import type {
  BackgroundTask,
  BackgroundTaskPatch,
  TaskLifecycleEvent,
  TaskStore,
} from '../../src/background-task/domain.js';
import type { LocalBackgroundTaskService } from '../../src/background-task/service.js';
import type { LocalTaskRunnerHostWithSessionLookup } from '../../src/api/local-task-host.js';
import type { LocalSessionRecord } from '../../src/sessions/controller.js';

// Shared fixtures for the background-task test suites. Extracted so both
// local-background-task.test.ts (store/service/reminders) and
// local-background-bash-runner.test.ts (runner/maxRunMs/reconcile/env) stay
// under the local-runtime test line budget without duplicating helpers.

export function taskRecord(
  taskId: string,
  ownerSessionId: string,
  overrides: Partial<BackgroundTask> = {},
): BackgroundTask {
  return {
    taskId,
    ownerSessionId,
    kind: 'subagent',
    status: 'queued',
    description: `Task ${taskId}`,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function backgroundBashHost(
  backgroundTaskService: LocalBackgroundTaskService,
  dataDir: string,
): LocalTaskRunnerHostWithSessionLookup {
  return {
    backgroundTaskService,
    matrixLogger: { warn: () => undefined },
    nowMs: () => 31_000,
    resolveDefaultWorkspaceDir: () => dataDir,
    getSessionById: async () => undefined,
  } as unknown as LocalTaskRunnerHostWithSessionLookup;
}

export function parentSessionRecord(dataDir: string): LocalSessionRecord {
  return {
    sessionId: 'session-a',
    agentName: 'mavis',
    workspaceDir: dataDir,
    runtime: 'pi-agent',
    sessionType: 'root',
    archived: false,
    pinned: false,
    status: 'idle',
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  } as unknown as LocalSessionRecord;
}

export async function waitForTaskStatus(
  service: LocalBackgroundTaskService,
  taskId: string,
  status: BackgroundTask['status'],
): Promise<BackgroundTask> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = await service.get(taskId);
    if (task?.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${taskId} to become ${status}`);
}

export async function waitForTaskOutput(
  service: LocalBackgroundTaskService,
  taskId: string,
  needle: string,
): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const output = await service.readOutput(toolContext('session-a'), taskId);
    if (output.content.includes(needle)) return output.content;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${taskId} output to contain ${needle}`);
}

export function toolContext(sessionId: string) {
  return {
    sessionId,
    turnId: `turn-${sessionId}`,
    toolCallId: `call-${sessionId}`,
    assistantMessageId: `message-${sessionId}`,
  };
}

export function taskStoreWithPatch(
  store: TaskStore,
  beforePatch: (taskId: string, patch: BackgroundTaskPatch) => Promise<void>,
): TaskStore {
  return {
    create: (task) => store.create(task),
    get: (taskId) => store.get(taskId),
    list: (query) => store.list(query),
    snapshotPending: () => store.snapshotPending(),
    reminderSnapshot: (ownerSessionId, limit) => store.reminderSnapshot(ownerSessionId, limit),
    updateStatus: (taskId, status, reason) => store.updateStatus(taskId, status, reason),
    appendEvent: (event: TaskLifecycleEvent) => store.appendEvent(event),
    patch: async (taskId, patch) => {
      await beforePatch(taskId, patch);
      return store.patch(taskId, patch);
    },
  };
}
