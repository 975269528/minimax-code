export type BackgroundTaskKind = 'bash' | 'subagent' | 'workflow' | 'custom';

export type BackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'lost';

export interface TaskError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}

export interface TaskUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export type TaskOutputKind = 'file' | 'oss' | 'sandbox_job' | 'session_transcript' | 'memory';

export interface TaskOutputRef {
  taskId: string;
  kind: TaskOutputKind;
  uri: string;
  offset?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export type TaskOutputStream = 'stdout' | 'stderr' | 'transcript' | 'final_result';

export interface TaskOutputChunk {
  taskId: string;
  stream?: TaskOutputStream;
  content: string;
  offset?: number;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface TaskOutputReadOptions {
  offset?: number;
  limitBytes?: number;
  stream?: TaskOutputStream;
}

export interface TaskOutputReadResult {
  content: string;
  nextOffset?: number;
  truncated?: boolean;
  summary?: string;
  outputRef?: TaskOutputRef;
}

export interface TaskOutputStore {
  append(chunk: TaskOutputChunk): Promise<TaskOutputRef>;
  read(taskId: string, options?: TaskOutputReadOptions): Promise<TaskOutputReadResult>;
  tail(taskId: string, limitBytes?: number): Promise<TaskOutputReadResult>;
  finalize(taskId: string, summary?: string): Promise<void>;
}

export interface BackgroundTask {
  taskId: string;
  kind: BackgroundTaskKind;
  status: BackgroundTaskStatus;
  ownerSessionId: string;
  description?: string;
  toolCallId?: string;
  parentMessageId?: string;
  parentTaskId?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
  deliveredAt?: number;
  outputRef?: TaskOutputRef;
  lastError?: TaskError;
  usage?: TaskUsage;
  metadata?: Record<string, unknown>;
}

export type BackgroundTaskPatch = Partial<
  Omit<BackgroundTask, 'taskId' | 'kind' | 'ownerSessionId' | 'createdAt'>
>;

export interface TaskQuery {
  taskIds?: string[];
  ownerSessionId?: string;
  parentTaskId?: string | null;
  kinds?: BackgroundTaskKind[];
  statuses?: BackgroundTaskStatus[];
  createdAfter?: number;
  createdBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  limit?: number;
  cursor?: string;
  orderBy?: 'created_at' | 'updated_at' | 'completed_at';
  order?: 'asc' | 'desc';
  includeArchived?: boolean;
  /** When true, only return tasks whose completion has not yet been delivered. */
  undeliveredOnly?: boolean;
}

export interface TaskListResult {
  items: BackgroundTask[];
  nextCursor?: string;
}

export type TaskLifecycleEventType =
  | 'created'
  | 'started'
  | 'output_updated'
  | 'stop_requested'
  | 'status_changed'
  | 'completed';

export interface TaskLifecycleEvent {
  eventId: string;
  taskId: string;
  ownerSessionId: string;
  type: TaskLifecycleEventType;
  timestamp: number;
  sequence?: number;
  payload?: Record<string, unknown>;
}

export interface TaskStore {
  create(task: BackgroundTask): Promise<BackgroundTask>;
  get(taskId: string): Promise<BackgroundTask | undefined>;
  list(query: TaskQuery): Promise<TaskListResult>;
  patch(taskId: string, patch: BackgroundTaskPatch): Promise<BackgroundTask>;
  updateStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    reason?: string,
  ): Promise<BackgroundTask>;
  appendEvent(event: TaskLifecycleEvent): Promise<void>;
}

export interface StartTaskRequest<TInput = unknown> {
  kind: BackgroundTaskKind;
  ownerSessionId: string;
  description?: string;
  toolCallId?: string;
  parentMessageId?: string;
  parentTaskId?: string | null;
  input: TInput;
  metadata?: Record<string, unknown>;
}

export interface TaskRuntimeHandle {
  taskId: string;
  outputRef?: TaskOutputRef;
  pid?: number;
  sandboxJobId?: string;
  subSessionId?: string;
  abortController?: AbortController;
}

export type TaskLivenessModel = 'lease' | 'poll' | 'callback';

export type TaskLivenessState = 'alive' | 'completed' | 'lost' | 'unknown';

export interface TaskLivenessResult {
  taskId: string;
  state: TaskLivenessState;
  checkedAt: number;
  status?: BackgroundTaskStatus;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface TaskRunner<TInput = unknown> {
  kind: BackgroundTaskKind;
  livenessModel?: TaskLivenessModel;
  start(task: BackgroundTask, input: TInput): Promise<TaskRuntimeHandle>;
  stop(taskId: string, reason?: string): Promise<void>;
  checkLiveness?(task: BackgroundTask): Promise<TaskLivenessResult>;
  getRuntimeState?(taskId: string): Promise<Record<string, unknown> | undefined>;
}

export interface CompleteTaskOptions {
  status?: Extract<BackgroundTaskStatus, 'succeeded' | 'canceled'>;
  outputRef?: TaskOutputRef;
  summary?: string;
  usage?: TaskUsage;
  metadata?: Record<string, unknown>;
}

export interface BackgroundTaskController {
  get(taskId: string): Promise<BackgroundTask | undefined>;
  list(query: TaskQuery): Promise<TaskListResult>;
  readOutput(taskId: string, options?: TaskOutputReadOptions): Promise<TaskOutputReadResult>;
  stop(taskId: string, reason?: string): Promise<BackgroundTask>;
  watch?(query: TaskQuery): AsyncIterable<TaskLifecycleEvent>;
}

export interface BackgroundTaskManager extends BackgroundTaskController {
  start<TInput>(request: StartTaskRequest<TInput>): Promise<BackgroundTask>;
  complete(taskId: string, options?: CompleteTaskOptions): Promise<BackgroundTask>;
  fail(taskId: string, error: unknown): Promise<BackgroundTask>;
}
