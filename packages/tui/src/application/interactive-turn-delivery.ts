import type { TuiStreamEvent } from '../runtime/stream-events.js';
import { createExecResultV1, type ExecResultV1 } from './exec-result.js';
import { TuiRunCoordinator, type TuiRunRequest, type TuiRunResult } from './run-coordinator.js';

export interface ExecuteTuiInteractiveTurnOptions {
  readonly request: TuiRunRequest;
  readonly coordinator: TuiRunCoordinator;
  readonly isActive: () => boolean;
  readonly onSessionEvent: (event: TuiStreamEvent) => void;
  readonly onRunAccepted?: () => void;
  readonly onResult?: (result: ExecResultV1) => void | Promise<void>;
}

/** Consumes the generated conversation stream directly as the sole Turn delivery. */
export function executeTuiInteractiveTurn(
  options: ExecuteTuiInteractiveTurnOptions,
): Promise<TuiRunResult> {
  return options.coordinator.execute(
    options.request,
    (event) => {
      if (options.isActive()) options.onSessionEvent(event);
    },
    options.onRunAccepted,
    options.onResult ? (outcome) => options.onResult?.(createExecResultV1(outcome)) : undefined,
  );
}
