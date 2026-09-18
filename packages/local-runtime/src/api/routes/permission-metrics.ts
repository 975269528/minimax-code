/**
 * MR8 permission metrics — emission helpers for the permission route flow.
 *
 * Bare metric names; the server-side pipeline owns the `local_runtime_`
 * prefix. Every helper is a noop when `metrics` is undefined (injection is
 * optional, zero behavior change). Labels are bounded enums only — never
 * sessionId/userId.
 */

import type { MetricsClient } from '../../common/metrics.js';
import type { LocalPermissionDecision, LocalPermissionRequest } from '../host-helpers.js';

/** `beforeLocalToolCall` verdict counter. */
export function emitPermissionRequestMetric(
  metrics: MetricsClient | undefined,
  mode: string,
  behavior: string,
): void {
  metrics?.counter('permission_request_total', 1, {
    mode,
    decision: behavior === 'deny' ? 'denied' : behavior === 'allow' ? 'allowed' : 'ask',
  });
}

/** New ask card announced (fingerprint-deduped asks do not re-emit). */
export function emitAskShownMetric(metrics: MetricsClient | undefined, mode: string): void {
  metrics?.counter('permission_ask_shown_total', 1, { mode });
}

/** Reply settle at the shared UI + IM choke point. */
export function emitAskReplyMetric(
  metrics: MetricsClient | undefined,
  decision: LocalPermissionDecision,
): void {
  metrics?.counter('permission_ask_reply_total', 1, {
    clkType:
      decision === 'allowOnce'
        ? 'allow_session'
        : decision === 'allowAlways'
          ? 'allow_global'
          : 'deny',
  });
}

/**
 * Shown → settle wait duration. `replied` = an explicit UI/IM decision;
 * `abandoned` = dismissed card, session abort, or turn-signal abort.
 */
export function emitAskWaitMetric(
  metrics: MetricsClient | undefined,
  nowMs: () => number,
  item: Pick<LocalPermissionRequest, 'createdAt'>,
  outcome: 'replied' | 'abandoned',
): void {
  metrics?.histogram('permission_ask_wait_ms', nowMs() - item.createdAt, { outcome });
}
