import { appendFile, mkdir, open, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  InvalidTaskStatusTransitionError,
  TaskAlreadyExistsError,
  TaskNotFoundError,
  canTransitionTaskStatus,
  type BackgroundTask,
  type BackgroundTaskReminderSnapshot,
  type BackgroundTaskPatch,
  type BackgroundTaskStatus,
  type TaskLifecycleEvent,
  type TaskListResult,
  type TaskOutputChunk,
  type TaskOutputReadOptions,
  type TaskOutputReadResult,
  type TaskOutputRef,
  type TaskOutputStore,
  type TaskQuery,
  type TaskStore,
} from './domain.js';

import { buildListSelection, getOrderValue, matchesQuery } from './task-query.js';
import {
  type DataDirInput,
  type DatabaseLike,
  runInImmediateTransaction,
  withLocalRuntimeDb,
} from '../persistence/db.js';

const DEFAULT_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_LIMIT = 500;
const DEFAULT_OUTPUT_READ_LIMIT_BYTES = 64 * 1024;
const UTF8_RANGE_ALIGNMENT_BYTES = 6;
const TASK_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface TaskRow {
  record_json?: string;
}

interface ReminderSnapshotRow extends TaskRow {
  undelivered_total?: number;
  terminal_total?: number;
}

export class SqliteLocalBackgroundTaskStore implements TaskStore {
  constructor(
    private readonly dataDir: DataDirInput,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async create(task: BackgroundTask): Promise<BackgroundTask> {
    return this.withDb((db) => {
      if (this.getInDb(db, task.taskId)) throw new TaskAlreadyExistsError(task.taskId);
      db.prepare(
        `
        INSERT INTO local_runtime_background_tasks (
          task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, delivered_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        task.taskId,
        task.ownerSessionId,
        task.kind,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.endedAt ?? null,
        task.deliveredAt ?? null,
        JSON.stringify(cloneTask(task)),
      );
      return cloneTask(task);
    });
  }

  async get(taskId: string): Promise<BackgroundTask | undefined> {
    return this.withDb((db) => this.getInDb(db, taskId));
  }

  async list(query: TaskQuery): Promise<TaskListResult> {
    return this.withDb((db) => {
      const order = query.order ?? 'desc';
      const orderBy = query.orderBy ?? 'created_at';
      const offset = parseCursor(query.cursor);
      const limit = clampLimit(query.limit);
      const tasks = this.readMatchingInDb(db, query).sort((left, right) => {
        const leftValue = getOrderValue(left, orderBy);
        const rightValue = getOrderValue(right, orderBy);
        return order === 'asc' ? leftValue - rightValue : rightValue - leftValue;
      });
      const items = tasks.slice(offset, offset + limit).map(cloneTask);
      const nextOffset = offset + items.length;
      return {
        items,
        ...(nextOffset < tasks.length ? { nextCursor: String(nextOffset) } : {}),
      };
    });
  }

  async snapshotPending(): Promise<BackgroundTask[]> {
    return this.withDb((db) =>
      this.readMatchingInDb(db, { statuses: ['queued', 'running', 'stopping'] }),
    );
  }

  async reminderSnapshot(
    ownerSessionId: string,
    limit = 5,
  ): Promise<BackgroundTaskReminderSnapshot> {
    return this.withDb((db) => {
      const rows = db
        .prepare(
          `
          WITH terminal AS (
            SELECT task_id, ended_at_ms, delivered_at_ms, record_json
            FROM local_runtime_background_tasks
            WHERE owner_session_id = ?
              AND status IN ('succeeded', 'failed', 'canceled', 'lost')
          ), counts AS (
            SELECT
              COUNT(*) AS terminal_total,
              SUM(CASE WHEN delivered_at_ms IS NULL THEN 1 ELSE 0 END) AS undelivered_total
            FROM terminal
          ), unread AS (
            SELECT record_json
            FROM terminal
            WHERE delivered_at_ms IS NULL
            ORDER BY ended_at_ms ASC, task_id ASC
            LIMIT ?
          )
          SELECT unread.record_json, counts.undelivered_total, counts.terminal_total
          FROM counts
          LEFT JOIN unread ON 1 = 1
        `,
        )
        .all(ownerSessionId, Math.max(0, Math.floor(limit))) as ReminderSnapshotRow[];
      const first = rows[0];
      return {
        tasks: rows.flatMap((row) => {
          const task = parseJson<BackgroundTask>(row.record_json);
          return task ? [cloneTask(task)] : [];
        }),
        undeliveredTotal: first?.undelivered_total ?? 0,
        terminalTotal: first?.terminal_total ?? 0,
      };
    });
  }

  async patch(taskId: string, patch: BackgroundTaskPatch): Promise<BackgroundTask> {
    return this.withDb((db) =>
      runInImmediateTransaction(db, () => {
        const current = this.getInDb(db, taskId);
        if (!current) throw new TaskNotFoundError(taskId);
        if (patch.status && !canTransitionTaskStatus(current.status, patch.status)) {
          throw new InvalidTaskStatusTransitionError(taskId, current.status, patch.status);
        }
        const updated: BackgroundTask = {
          ...current,
          ...patch,
          metadata: mergeRecord(current.metadata, patch.metadata),
          updatedAt: patch.updatedAt ?? this.nowMs(),
        };
        this.upsertInDb(db, updated);
        return cloneTask(updated);
      }),
    );
  }

  async updateStatus(
    taskId: string,
    status: BackgroundTaskStatus,
    reason?: string,
  ): Promise<BackgroundTask> {
    const patch: BackgroundTaskPatch = { status };
    if (reason && ['failed', 'canceled', 'lost'].includes(status)) {
      patch.lastError = { message: reason, code: status.toUpperCase() };
    }
    return this.patch(taskId, patch);
  }

  async appendEvent(event: TaskLifecycleEvent): Promise<void> {
    this.withDb((db) => {
      db.prepare(
        `
        INSERT OR IGNORE INTO local_runtime_background_task_events (
          event_id, task_id, owner_session_id, type, timestamp_ms, sequence, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        event.eventId,
        event.taskId,
        event.ownerSessionId,
        event.type,
        event.timestamp,
        event.sequence ?? null,
        event.payload ? JSON.stringify(event.payload) : null,
      );
    });
  }

  private readMatchingInDb(db: DatabaseLike, query: TaskQuery): BackgroundTask[] {
    const selection = buildListSelection(query);
    return db
      .prepare(selection.sql)
      .all(...selection.params)
      .flatMap((row) => {
        const task = parseJson<BackgroundTask>((row as TaskRow).record_json);
        return task && matchesQuery(task, query) ? [task] : [];
      });
  }

  private getInDb(db: DatabaseLike, taskId: string): BackgroundTask | undefined {
    const row = db
      .prepare('SELECT record_json FROM local_runtime_background_tasks WHERE task_id = ?')
      .get(taskId) as TaskRow | undefined;
    const task = parseJson<BackgroundTask>(row?.record_json);
    return task ? cloneTask(task) : undefined;
  }

  private upsertInDb(db: DatabaseLike, task: BackgroundTask): void {
    db.prepare(
      `
      INSERT INTO local_runtime_background_tasks (
        task_id, owner_session_id, kind, status, created_at_ms, updated_at_ms, ended_at_ms, delivered_at_ms, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        owner_session_id = excluded.owner_session_id,
        kind = excluded.kind,
        status = excluded.status,
        created_at_ms = excluded.created_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        ended_at_ms = excluded.ended_at_ms,
        delivered_at_ms = excluded.delivered_at_ms,
        record_json = excluded.record_json
    `,
    ).run(
      task.taskId,
      task.ownerSessionId,
      task.kind,
      task.status,
      task.createdAt,
      task.updatedAt,
      task.endedAt ?? null,
      task.deliveredAt ?? null,
      JSON.stringify(cloneTask(task)),
    );
  }

  private withDb<T>(fn: (db: DatabaseLike) => T): T {
    return withLocalRuntimeDb(this.dataDir, fn);
  }
}

export class FsLocalTaskOutputStore implements TaskOutputStore {
  constructor(private readonly dataDir: DataDirInput) {}

  async append(chunk: TaskOutputChunk): Promise<TaskOutputRef> {
    const file = this.outputFile(chunk.taskId);
    await mkdir(path.dirname(file), { recursive: true });
    const currentSize = await stat(file)
      .then((info) => info.size)
      .catch(() => 0);
    const offset = chunk.offset ?? currentSize;
    await appendFile(file, chunk.content, 'utf8');
    return {
      taskId: chunk.taskId,
      kind: 'file',
      uri: file,
      offset: offset + Buffer.byteLength(chunk.content, 'utf8'),
      updatedAt: chunk.timestamp ?? Date.now(),
    };
  }

  async read(taskId: string, options: TaskOutputReadOptions = {}): Promise<TaskOutputReadResult> {
    const file = this.outputFile(taskId);
    const offset = normalizeByteOffset(options.offset);
    const limit = Math.max(0, options.limitBytes ?? DEFAULT_OUTPUT_READ_LIMIT_BYTES);
    const slice = await readUtf8Range(file, offset, limit);
    const updatedAt = await mtimeMs(file);
    return {
      content: slice.content,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      outputRef: {
        taskId,
        kind: 'file',
        uri: file,
        offset: slice.nextOffset,
        ...(updatedAt === undefined ? {} : { updatedAt }),
      },
    };
  }

  async tail(taskId: string, limitBytes = 8_192): Promise<TaskOutputReadResult> {
    const file = this.outputFile(taskId);
    const size = await stat(file)
      .then((info) => info.size)
      .catch(() => 0);
    const offset = Math.max(0, size - limitBytes);
    return this.read(taskId, { offset, limitBytes });
  }

  async finalize(taskId: string, summary?: string): Promise<void> {
    if (summary === undefined) return;
    const file = this.summaryFile(taskId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, summary, 'utf8');
  }

  private outputFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'output.log');
  }

  private summaryFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'summary.txt');
  }

  private taskDir(taskId: string): string {
    if (!TASK_ID_PATTERN.test(taskId))
      throw new Error(`Invalid local background task id: ${taskId}`);
    return path.join(resolveDataDir(this.dataDir), 'background-tasks', taskId);
  }
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || limit <= 0) return DEFAULT_TASK_LIST_LIMIT;
  return Math.min(Math.floor(limit), MAX_TASK_LIST_LIMIT);
}

function mergeRecord(
  current: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!current && !patch) return undefined;
  return { ...(current ?? {}), ...(patch ?? {}) };
}

function cloneTask(task: BackgroundTask): BackgroundTask {
  return {
    ...task,
    outputRef: task.outputRef
      ? { ...task.outputRef, metadata: cloneRecord(task.outputRef.metadata) }
      : undefined,
    lastError: task.lastError
      ? { ...task.lastError, details: cloneRecord(task.lastError.details) }
      : undefined,
    usage: task.usage ? { ...task.usage, metadata: cloneRecord(task.usage.metadata) } : undefined,
    metadata: cloneRecord(task.metadata),
  };
}

function cloneRecord<T extends Record<string, unknown> | undefined>(value: T): T {
  return (value ? { ...value } : undefined) as T;
}

function parseJson<T>(raw: string | undefined | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readUtf8Range(
  file: string,
  offset: number,
  limitBytes: number,
): Promise<{ content: string; nextOffset: number; truncated: boolean }> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return { content: '', nextOffset: 0, truncated: false };
  }
  try {
    const size = (await handle.stat()).size;
    const readOffset = Math.min(offset, size);
    // An arbitrary offset may first skip three continuation bytes, then need
    // three more bytes to complete a 4-byte code point at the page end.
    const buffer = Buffer.alloc(
      Math.min(size - readOffset, limitBytes + UTF8_RANGE_ALIGNMENT_BYTES),
    );
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
    const available = buffer.subarray(0, bytesRead);
    let start = 0;
    while (isUtf8ContinuationByte(available[start] ?? 0)) start += 1;
    let end = Math.min(available.length, start + limitBytes);
    const absoluteEnd = readOffset + end;
    while (end > start && absoluteEnd < size && isUtf8ContinuationByte(available[end] ?? 0))
      end -= 1;
    if (end === start && start < available.length && limitBytes > 0) {
      end += 1;
      while (end < available.length && isUtf8ContinuationByte(available[end] ?? 0)) end += 1;
    }
    return {
      content: available.subarray(start, end).toString('utf8'),
      nextOffset: readOffset + end,
      truncated: readOffset + end < size,
    };
  } finally {
    await handle.close();
  }
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function normalizeByteOffset(offset: number | undefined): number {
  return Number.isFinite(offset) ? Math.max(0, Math.floor(offset ?? 0)) : 0;
}

async function mtimeMs(file: string): Promise<number | undefined> {
  return stat(file)
    .then((info) => Math.floor(info.mtimeMs))
    .catch(() => undefined);
}

function resolveDataDir(dataDir: DataDirInput): string {
  return typeof dataDir === 'function' ? dataDir() : dataDir;
}
