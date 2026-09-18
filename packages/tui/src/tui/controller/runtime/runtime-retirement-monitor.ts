import { formatTuiActionFailure } from '../../../user-facing-failure.js';

const DEFAULT_RETIREMENT_WARNING_TIMEOUT_MS = 5_000;

interface TuiRetirementStatePatch {
  readonly status?: 'idle' | 'error';
  readonly retiringTurnId?: undefined;
  readonly error?: string | undefined;
}

export interface TuiRuntimeRetirementMonitorOptions {
  readonly turnId: string;
  readonly retirement: Promise<boolean>;
  readonly timeoutMs?: number;
  readonly currentTurnId: () => string | undefined;
  readonly apply: (patch: TuiRetirementStatePatch) => void;
  readonly onSettled: () => void;
}

export function monitorTuiRuntimeRetirement(options: TuiRuntimeRetirementMonitorOptions): void {
  const timeoutMessage =
    'Runtime is taking too long to stop the previous response. New messages remain blocked until Runtime releases the Session.';
  let timeoutShown = false;
  const timeout = setTimeout(
    () => {
      if (options.currentTurnId() !== options.turnId) return;
      timeoutShown = true;
      options.apply({ status: 'error', error: timeoutMessage });
    },
    Math.max(0, options.timeoutMs ?? DEFAULT_RETIREMENT_WARNING_TIMEOUT_MS),
  );
  timeout.unref?.();

  void options.retirement.then(
    (released) => {
      clearTimeout(timeout);
      if (options.currentTurnId() !== options.turnId) return;
      options.apply({
        retiringTurnId: undefined,
        ...(released
          ? timeoutShown
            ? { status: 'idle', error: undefined }
            : {}
          : {
              status: 'error',
              error: 'Runtime could not confirm that the previous turn stopped.',
            }),
      });
      options.onSettled();
    },
    (error: unknown) => {
      clearTimeout(timeout);
      if (options.currentTurnId() !== options.turnId) return;
      options.apply({
        status: 'error',
        retiringTurnId: undefined,
        error: formatTuiActionFailure(error, {
          summary: "Couldn't confirm that the previous response stopped.",
          nextStep: 'Retry Esc.',
          preservation: 'New messages remain blocked.',
        }),
      });
      options.onSettled();
    },
  );
}
