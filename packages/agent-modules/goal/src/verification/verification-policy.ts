import type { EvaluatorRouteKind } from './evaluator-adapter.js';
import type { ThreadGoalVerification } from '../types.js';

/**
 * Which verification backend a Goal runs, derived from the model route the
 * worker turn actually used.
 *
 * The mode is **not** a persisted, user-picked property of a Goal: there is no
 * default, no initialization, and no UI for it. A user who wants a specific
 * mode writes `goal.verification` into the config file; everyone else gets the
 * route-derived answer below, recomputed on every settlement.
 *
 * Routes we bill ourselves (`managed_token_plan`, `minimax_api_key`) can afford
 * a read-only subagent verifier. BYOK routes (`custom_provider`,
 * `configured_provider`) spend the user's own quota, so we accept the worker's
 * completion proposal instead of silently doubling their bill.
 */
export function verificationModeForRoute(
  kind: EvaluatorRouteKind | undefined,
): ThreadGoalVerification {
  if (kind === 'managed_token_plan' || kind === 'minimax_api_key') return 'subagent';
  // `custom_provider` / `configured_provider`, and any route we could not
  // resolve at all, settle on the worker's proposal.
  return 'none';
}
