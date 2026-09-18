import { SessionServiceError } from '../errors.js';

export interface SessionMaintenanceLease {
  readonly sessionId: string;
  readonly leaseId: string;
  readonly renewAfterMs: number;
}

export interface SessionMaintenanceGuard {
  tryAcquireSessionMaintenance(sessionId: string): Promise<SessionMaintenanceLease | undefined>;
  renewSessionMaintenance(lease: SessionMaintenanceLease): Promise<boolean>;
  releaseSessionMaintenance(lease: SessionMaintenanceLease): Promise<void>;
}

export interface MaintenanceMutationLane {
  readonly signal: AbortSignal;
  run<T>(participant: () => Promise<T>): Promise<T>;
  stop(): Promise<void>;
}

export type SessionMaintenanceAttempt<T> =
  | { readonly acquired: true; readonly value: T }
  | { readonly acquired: false };

type AsyncOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export class SessionMaintenanceService {
  constructor(private readonly guard: SessionMaintenanceGuard) {}

  async runExclusive<T>(
    sessionId: string,
    operation: (lane: MaintenanceMutationLane) => Promise<T>,
  ): Promise<T> {
    const lease = await this.guard.tryAcquireSessionMaintenance(sessionId);
    if (!lease) {
      throw new SessionServiceError('session-busy', `Session is busy: ${sessionId}`);
    }
    return runWithLease(this.guard, lease, operation);
  }

  async tryRunExclusive<T>(
    sessionId: string,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<SessionMaintenanceAttempt<T>> {
    const lease = await this.guard.tryAcquireSessionMaintenance(sessionId);
    if (!lease) return { acquired: false };
    return {
      acquired: true,
      value: await runWithLease(this.guard, lease, (lane) =>
        lane.run(() => operation(lane.signal)),
      ),
    };
  }
}

async function runWithLease<T>(
  guard: SessionMaintenanceGuard,
  lease: SessionMaintenanceLease,
  operation: (lane: MaintenanceMutationLane) => Promise<T>,
): Promise<T> {
  const lane = startMaintenanceMutationLane(guard, lease);
  const operationOutcome = await captureOutcome(() => operation(lane));
  const renewalOutcome = await captureOutcome(() => lane.stop());
  const releaseOutcome = await captureOutcome(() => guard.releaseSessionMaintenance(lease));
  const failures = uniqueFailures([operationOutcome, renewalOutcome, releaseOutcome]);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Session maintenance mutation failed: ${lease.sessionId}`);
  }
  if (!operationOutcome.ok) throw operationOutcome.error;
  return operationOutcome.value;
}

function startMaintenanceMutationLane(
  guard: SessionMaintenanceGuard,
  lease: SessionMaintenanceLease,
): MaintenanceMutationLane {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewalInFlight: Promise<void> | undefined;
  let scheduledRenewal: Promise<void> | undefined;
  let renewalFailure: { readonly error: unknown } | undefined;
  let stopped = false;
  const controller = new AbortController();

  const performRenewal = async (): Promise<void> => {
    const outcome = await captureOutcome(() => guard.renewSessionMaintenance(lease));
    if (!outcome.ok && !renewalFailure) renewalFailure = { error: outcome.error };
    else if (outcome.ok && !outcome.value && !renewalFailure) {
      renewalFailure = {
        error: new SessionServiceError(
          'maintenance-lease-lost',
          `Session maintenance lease was lost: ${lease.sessionId}`,
        ),
      };
    }
    if (renewalFailure) {
      controller.abort(renewalFailure.error);
      throw renewalFailure.error;
    }
  };

  const renewNow = (): Promise<void> => {
    if (renewalFailure) return Promise.reject(renewalFailure.error);
    if (renewalInFlight) return renewalInFlight;
    const renewal = performRenewal();
    const tracked = (async (): Promise<void> => {
      try {
        await renewal;
      } finally {
        renewalInFlight = undefined;
      }
    })();
    renewalInFlight = tracked;
    return tracked;
  };

  async function renewAndSchedule(): Promise<void> {
    try {
      await renewNow();
      schedule();
    } catch {
      // Renewal failure is retained and raised by the fenced lane.
    }
  }

  function schedule(): void {
    if (stopped || renewalFailure) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        scheduledRenewal = renewAndSchedule();
      },
      Math.max(1, lease.renewAfterMs),
    );
    timer.unref?.();
  }

  schedule();
  return {
    signal: controller.signal,
    run: async <T>(participant: () => Promise<T>): Promise<T> => {
      await renewNow();
      const result = await participant();
      await renewNow();
      return result;
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await scheduledRenewal;
      await renewalInFlight;
      if (renewalFailure) throw renewalFailure.error;
    },
  };
}

function uniqueFailures(outcomes: readonly AsyncOutcome<unknown>[]): unknown[] {
  return [...new Set(outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error])))];
}

async function captureOutcome<T>(operation: () => Promise<T>): Promise<AsyncOutcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}
