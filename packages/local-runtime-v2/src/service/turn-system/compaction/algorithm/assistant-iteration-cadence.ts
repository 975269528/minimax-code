import { TODO_CADENCE_INTERVAL } from '../compat.js';

export function advanceAssistantIterationCadence(value: number): number {
  return Math.min(TODO_CADENCE_INTERVAL, value + 1);
}
