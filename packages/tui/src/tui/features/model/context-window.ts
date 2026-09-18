import type { TuiModel } from '../../../runtime/port.js';

export { formatContextWindow } from '../../../application/context-window.js';

export function contextWindowOptions(model: TuiModel): number[] {
  return [...new Set(model.contextWindowOptions ?? [])].filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
}
