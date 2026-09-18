/**
 * Initial LLM integration for desktop error reporting.
 *
 * Build the {@link PiLLMRequestFailureHook} injected by local-runtime into PiTurnRunner. agent-core
 * calls it for every physical provider request failure after filtering user cancellations. Format
 * the error here and enqueue a `llm_request_failure` event.
 *
 * As required by the design, code_location is a fixed file path + function name without a line
 * number, pointing to the actual failure observation site in agent-core.
 */

import type { PiLLMRequestFailureHook } from '@mavis/agent-core/pi-turn-runner';

import { formatErrorLog } from './reporter.js';
import type { DesktopErrorReporter } from './types.js';

/** Event type for the initial LLM provider failure logs. */
export const LLM_REQUEST_FAILURE_EVENT_TYPE = 'llm_request_failure';

/**
 * Fixed LLM failure code location: the physical request completion observation point in agent-core.
 * Omit line numbers so unrelated file edits do not change the value.
 */
export const LLM_REQUEST_FAILURE_CODE_LOCATION =
  'packages/agent-core/src/pi-turn-runner/metrics.ts#recordLLMSettled';

export interface LLMFailureReportHookOptions {
  /** Current desktop or CLI product version, included in the structured error log before encryption. */
  appVersion?: string;
}

/**
 * Adapt {@link DesktopErrorReporter} to an agent-core failure hook. The returned function is safe
 * for `onLLMRequestFailure`: `report(...)` never throws, and agent-core adds another guard.
 */
export function createLLMFailureReportHook(
  reporter: DesktopErrorReporter,
  options: LLMFailureReportHookOptions = {},
): PiLLMRequestFailureHook {
  const appVersion = options.appVersion?.trim();
  return (info) => {
    reporter.report({
      event_type: LLM_REQUEST_FAILURE_EVENT_TYPE,
      event_log: formatErrorLog({
        ...(appVersion ? { appVersion } : {}),
        ...(info.error !== undefined ? { error: info.error } : {}),
        ...(info.providerError !== undefined ? { providerError: info.providerError } : {}),
        ...(info.errorMessage !== undefined ? { errorMessage: info.errorMessage } : {}),
        metricKind: info.metricKind,
        request: info.request,
      }),
      occurred_at_ms: info.occurredAtMs,
      code_location: LLM_REQUEST_FAILURE_CODE_LOCATION,
    });
  };
}
