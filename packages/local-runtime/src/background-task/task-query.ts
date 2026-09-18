import { isTerminalTaskStatus, type BackgroundTask, type TaskQuery } from './domain.js';

export function matchesQuery(task: BackgroundTask, query: TaskQuery): boolean {
  if (query.taskIds && !query.taskIds.includes(task.taskId)) return false;
  if (query.ownerSessionId && task.ownerSessionId !== query.ownerSessionId) return false;
  if (query.parentTaskId !== undefined && (task.parentTaskId ?? null) !== query.parentTaskId) {
    return false;
  }
  if (query.kinds && !query.kinds.includes(task.kind)) return false;
  if (query.statuses && !query.statuses.includes(task.status)) return false;
  if (query.createdAfter !== undefined && task.createdAt < query.createdAfter) return false;
  if (query.createdBefore !== undefined && task.createdAt > query.createdBefore) return false;
  if (query.updatedAfter !== undefined && task.updatedAt < query.updatedAfter) return false;
  if (query.updatedBefore !== undefined && task.updatedAt > query.updatedBefore) return false;
  if (
    query.undeliveredOnly &&
    (!isTerminalTaskStatus(task.status) || task.deliveredAt !== undefined)
  ) {
    return false;
  }
  return true;
}

export function buildListSelection(query: TaskQuery): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (query.taskIds) {
    if (query.taskIds.length === 0)
      return { sql: 'SELECT record_json FROM local_runtime_background_tasks WHERE 0', params: [] };
    clauses.push(`task_id IN (${query.taskIds.map(() => '?').join(', ')})`);
    params.push(...query.taskIds);
  }
  if (query.ownerSessionId) {
    clauses.push('owner_session_id = ?');
    params.push(query.ownerSessionId);
  }
  if (query.statuses) {
    if (query.statuses.length === 0)
      return { sql: 'SELECT record_json FROM local_runtime_background_tasks WHERE 0', params: [] };
    clauses.push(`status IN (${query.statuses.map(() => '?').join(', ')})`);
    params.push(...query.statuses);
  }
  if (query.createdAfter !== undefined) {
    clauses.push('created_at_ms >= ?');
    params.push(query.createdAfter);
  }
  if (query.createdBefore !== undefined) {
    clauses.push('created_at_ms <= ?');
    params.push(query.createdBefore);
  }
  if (query.updatedAfter !== undefined) {
    clauses.push('updated_at_ms >= ?');
    params.push(query.updatedAfter);
  }
  if (query.updatedBefore !== undefined) {
    clauses.push('updated_at_ms <= ?');
    params.push(query.updatedBefore);
  }
  if (query.undeliveredOnly) {
    clauses.push('delivered_at_ms IS NULL');
  }

  return {
    sql: `SELECT record_json FROM local_runtime_background_tasks${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`,
    params,
  };
}

export function getOrderValue(
  task: BackgroundTask,
  orderBy: NonNullable<TaskQuery['orderBy']>,
): number {
  if (orderBy === 'updated_at') return task.updatedAt;
  if (orderBy === 'completed_at') return task.endedAt ?? 0;
  return task.createdAt;
}
