import type { MetricsClient } from '../common/metrics.js';
import type { SafetyCheckResult, SafetyScene } from '../content-safety/api.js';

/** Sliding-window flush threshold in characters (matches archon-server charsThreshold). */
export const OUTPUT_SAFETY_CHUNK_THRESHOLD = 80;

/**
 * Retries of a single review window when the call resolves to `local_error`
 * (no verdict: offline / timeout / 4xx auth / unusable body) — an infra
 * failure, not a content verdict, so retrying the SAME text may succeed once
 * the hiccup clears. Total attempts = 1 initial + this many; on exhaustion the
 * writer soft-stops the turn (see `LocalOutputSafetyEventWriter.networkStopped`).
 */
export const OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES = 3;

/**
 * Upper bound (ms) of the randomized backoff before each `local_error` retry:
 * a uniform random in `[0, this]`, jitter that avoids hammering an unreachable
 * gateway and de-syncs concurrent turns. Not applied before the initial call,
 * nor for a real `rejected` / `api_error` verdict.
 */
export const OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS = 5_000;

/** Default randomized backoff before re-submitting one `local_error` review window. */
export function defaultOutputSafetyLocalErrorRetryDelay(): Promise<void> {
  const delayMs = Math.floor(Math.random() * (OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS + 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export interface LocalOutputSafetyDeps {
  /**
   * Synchronous review of one text window. Resolves pass/fail; any infra
   * `errorKind` (`api_error` or `local_error`) is treated as fail-open here (do
   * not block model output on infra errors, whether the gateway was degraded or
   * unreachable).
   */
  checkText: (content: string, scene: SafetyScene) => Promise<SafetyCheckResult>;
  /** Sliding-window flush threshold in characters (default 80). */
  chunkThreshold?: number;
  /**
   * How many times a `local_error` review is re-submitted before giving up on
   * the network (default {@link OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES}). Only
   * `local_error` is retried — a real `rejected` verdict or an `api_error`
   * degrade-pass never loops here.
   */
  localErrorMaxRetries?: number;
  /**
   * Sleep hook used to wait a randomized backoff before each `local_error`
   * retry. Defaults to a real `setTimeout` for a uniform-random delay in
   * `[0, OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS]`. Injectable so tests run
   * instantly (pass a no-op) and so the randomness stays out of the hot path.
   * Called once per retry, never before the initial review call.
   */
  retryDelay?: () => Promise<void>;
  /**
   * Invoked the first time review blocks this attempt. The host wires this to an
   * internal AbortController so pi stops generating the rest of the (doomed) turn
   * early. Optional — correctness never depends on it: the `blocked` flag, read
   * after `runTurn` resolves, is the single source of truth.
   */
  onBlocked?: () => void;
  /**
   * Whether a network soft-stop synthesizes the approved-prefix final
   * `AgentMessage` that persists it to the display store (default true).
   * Background delivery sets this false — it re-delivers the whole turn and has
   * no live viewer, so a persisted half-answer would duplicate/stale against the
   * retry. Foreground keeps it so a watching user retains the approved answer.
   */
  persistApprovedPartialOnNetworkStop?: boolean;
  /**
   * Host-injected metrics client (facade `common/metrics.ts`) for the
   * `output_safety_*` series. OPTIONAL — absent client = noop, zero behavior
   * change; every emission site is `?.` guarded. Labels are bounded enums only
   * (decision / errorKind), never content or ids.
   */
  metricsClient?: MetricsClient;
}
