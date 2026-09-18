import { randomUUID } from 'node:crypto';

export type IdGenerator = () => string;

export function createBackgroundTaskId(): string {
  return `bg_${randomUUID()}`;
}

export function createTaskLifecycleEventId(): string {
  return `bge_${randomUUID()}`;
}
