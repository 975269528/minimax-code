/**
 * Local subagent tasks encode their taskId in the Turn id instead of storing a
 * second `turn_id` column. The encoding is the long-standing background task
 * rule, so an existing row stays resolvable after an upgrade; it is a reversible
 * index only, and the task row read by taskId remains the authoritative link.
 */
const LOCAL_SUBAGENT_TASK_TURN_PREFIX = 'turn_task_bg_';

export function taskTurnId(taskId: string): string {
  return `${LOCAL_SUBAGENT_TASK_TURN_PREFIX}${taskId}`;
}

export function taskIdFromTurnId(turnId: string): string | undefined {
  if (!turnId.startsWith(LOCAL_SUBAGENT_TASK_TURN_PREFIX)) return undefined;
  const taskId = turnId.slice(LOCAL_SUBAGENT_TASK_TURN_PREFIX.length);
  return taskId.length > 0 ? taskId : undefined;
}
