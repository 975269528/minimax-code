/**
 * Desktop error-log reporting, for local-runtime only.
 *
 * A generic in-memory pipeline: batch error events, encrypt each event_log with the current login
 * token, then POST to Matrix Gateway. Failures must never affect the main flow. The initial
 * consumer is physical LLM provider request failures. See ./types.ts for constraints and
 * ./reporter.ts for the flow.
 */

export {
  DESKTOP_ERROR_REPORTING_DEFAULTS,
  MAX_EVENT_LOG_BYTES,
  type DesktopErrorLog,
  type DesktopErrorReporter,
  type DesktopErrorReporterOptions,
} from './types.js';
export { createDesktopErrorReporter, formatErrorLog } from './reporter.js';
export {
  createLLMFailureReportHook,
  LLM_REQUEST_FAILURE_CODE_LOCATION,
  LLM_REQUEST_FAILURE_EVENT_TYPE,
} from './llm-integration.js';
export {
  buildAssociatedData,
  deriveEventLogKey,
  encryptEventLog,
  EVENT_LOG_WIRE_VERSION,
  HKDF_SALT,
} from './crypto.js';
