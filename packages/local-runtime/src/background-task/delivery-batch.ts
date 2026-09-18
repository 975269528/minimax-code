import type { BackgroundTask } from './domain.js';
import { buildBackgroundTaskDeliveryInput } from './conversation-delivery.js';

export const MAX_TASKS_PER_DELIVERY_BATCH = 32;
export const MAX_DELIVERY_INPUT_BYTES = 8 * 1_024;
const MAX_DESCRIPTION_BYTES = 256;
const MAX_GENERATED_TURN_ID = `turn_task_delivery_${'0'.repeat(32)}`;

// Internal notification budget, not a guarantee of any model's remaining context; normal Task IDs are bg_ + UUID (39 bytes).
// Shorten only notification previews; Task retains the full description and result.
export function createDeliveryTaskPreview(task: BackgroundTask): BackgroundTask {
  const preview: BackgroundTask = {
    taskId: task.taskId,
    ownerSessionId: task.ownerSessionId,
    kind: task.kind,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
    ...(task.description
      ? { description: truncateUtf8(task.description, MAX_DESCRIPTION_BYTES) }
      : {}),
  };
  if (deliveryInputBytes([preview]) <= MAX_DELIVERY_INPUT_BYTES) return preview;
  delete preview.description;
  if (deliveryInputBytes([preview]) <= MAX_DELIVERY_INPUT_BYTES) return preview;
  // Do not truncate opaque Task/Session identities or send oversized individual notifications.
  throw new RangeError(
    `Background task notice identity exceeds ${MAX_DELIVERY_INPUT_BYTES} bytes (task ID: ${Buffer.byteLength(task.taskId, 'utf8')} bytes)`,
  );
}

/** Take the next batch in FIFO order and freeze its membership; each batch must satisfy both task-count and serialized-byte budgets. */
export function selectDeliveryBatch(
  pending: ReadonlyMap<string, BackgroundTask>,
): readonly BackgroundTask[] {
  const selected: BackgroundTask[] = [];
  for (const task of pending.values()) {
    if (selected.length >= MAX_TASKS_PER_DELIVERY_BATCH) break;
    if (deliveryInputBytes([...selected, task]) > MAX_DELIVERY_INPUT_BYTES) break;
    selected.push(task);
  }
  return selected.sort((left, right) =>
    left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
  );
}

function deliveryInputBytes(tasks: readonly BackgroundTask[]): number {
  const ownerSessionId = tasks[0]?.ownerSessionId ?? '';
  const input = buildBackgroundTaskDeliveryInput({
    ownerSessionId,
    tasks,
    batchTaskIds: tasks.map((task) => task.taskId),
    observedTerminalCount: Number.MAX_SAFE_INTEGER,
    requestedTurnId: MAX_GENERATED_TURN_ID,
  });
  return Buffer.byteLength(JSON.stringify(input), 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) {
      while (bytes > maxBytes - 3) bytes -= Buffer.byteLength(characters.pop() ?? '', 'utf8');
      return `${characters.join('')}…`;
    }
    characters.push(character);
    bytes += size;
  }
  return characters.join('');
}
