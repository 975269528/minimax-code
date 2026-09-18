import type { BackgroundTaskStatus } from './types.js';

export const ACTIVE_TASK_STATUSES: ReadonlyArray<BackgroundTaskStatus> = [
  'queued',
  'running',
  'stopping',
];

export const TERMINAL_TASK_STATUSES: ReadonlyArray<BackgroundTaskStatus> = [
  'succeeded',
  'failed',
  'canceled',
  'lost',
];

export function isActiveTaskStatus(status: BackgroundTaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export function isTerminalTaskStatus(status: BackgroundTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function canTransitionTaskStatus(
  from: BackgroundTaskStatus,
  to: BackgroundTaskStatus,
): boolean {
  if (from === to) return true;
  if (isTerminalTaskStatus(from)) return false;

  switch (from) {
    case 'queued':
      return ['running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
    case 'running':
      return ['stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
    case 'stopping':
      return ['succeeded', 'failed', 'canceled', 'lost'].includes(to);
    default:
      return false;
  }
}
