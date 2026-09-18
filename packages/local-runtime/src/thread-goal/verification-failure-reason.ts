import type {
  ThreadGoalSettleBoundTurnInput,
  ThreadGoalStatusReason,
  VerificationDispatchFailureCode,
} from '@mavis/goal';

/**
 * Map a verifier dispatch failure onto the status reason that names its *owner*.
 *
 * Every failure pauses — the Goal is never advanced on an unproven verdict — so
 * the only free variable is the reason, and the reason is the whole diagnostic
 * value. Collapsing 12 codes into `paused(verifier_unavailable)` means a
 * production pause tells an on-call engineer nothing about which layer to open:
 * a leaked API key, a prompt that outgrew the context window, a crashed child,
 * and a workspace edited mid-verification all read identically.
 *
 * The grouping is deliberately coarser than the code set: it is keyed on *who
 * fixes it*, not on what threw. Two codes with the same owner share a reason so
 * the closed reason union does not have to grow with every new adapter detail.
 *
 * | reason | owner layer |
 * | --- | --- |
 * | `paused(route_unavailable)` | model routing / provider config |
 * | `paused(verifier_unavailable)` | provider call (transient; retry) |
 * | `paused(verifier_timeout)` | verifier latency vs. the configured cap |
 * | `paused(verifier_protocol)` | verifier prompt / verdict contract |
 * | `paused(verifier_runtime)` | host subagent runtime |
 * | `paused(verifier_budget)` | verifier child's configured execution cap |
 * | `paused(verifier_capability)` | readonly guard / tool catalog |
 * | `paused(verifier_aborted)` | host lifecycle — not a defect |
 */
const FAILURE_REASONS: Readonly<Record<VerificationDispatchFailureCode, ThreadGoalStatusReason>> = {
  route_unavailable: 'paused(route_unavailable)',
  api_error: 'paused(verifier_unavailable)',
  timeout: 'paused(verifier_timeout)',
  schema_error: 'paused(verifier_protocol)',
  input_too_large: 'paused(verifier_protocol)',
  spawn_failed: 'paused(verifier_runtime)',
  child_crash: 'paused(verifier_runtime)',
  child_budget_exhausted: 'paused(verifier_budget)',
  capability_violation: 'paused(verifier_capability)',
  aborted: 'paused(verifier_aborted)',
};

export function threadGoalVerificationFailureReason(
  code: VerificationDispatchFailureCode,
): ThreadGoalStatusReason {
  return FAILURE_REASONS[code];
}

export function threadGoalVerificationFailureTransition(
  code: VerificationDispatchFailureCode,
): ThreadGoalSettleBoundTurnInput['next'] {
  return { status: 'paused', statusReason: threadGoalVerificationFailureReason(code) };
}

/**
 * Same mapping for an `inconclusive` verdict, whose `code` is a free-form string
 * (the host stamps `schema_error`; a model may return anything). Unrecognized
 * codes stay on the retryable reason rather than being
 * attributed to a layer we cannot name from the code alone.
 */
export function threadGoalInconclusiveTransition(
  code: string,
): ThreadGoalSettleBoundTurnInput['next'] {
  const known = Object.hasOwn(FAILURE_REASONS, code)
    ? FAILURE_REASONS[code as VerificationDispatchFailureCode]
    : 'paused(verifier_unavailable)';
  return { status: 'paused', statusReason: known };
}
