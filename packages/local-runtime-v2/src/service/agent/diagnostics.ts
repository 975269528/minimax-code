/**
 * Redaction helpers shared by every Agent diagnostic log site.
 *
 * Agent failures travel with user-authored material attached: canonical Agent
 * files, personas, system prompts and provider credentials all reach this
 * layer. An unknown throwable may therefore carry any of that on its own
 * enumerable properties, so diagnostics never spread or `JSON.stringify` an
 * error — they read the three bounded fields below and nothing else.
 */

/** Long enough to identify a failure class, short enough to exclude a prompt body. */
const MAX_ERROR_MESSAGE_CHARS = 300;
/** A few frames are enough to locate the throw site; the rest is noise on disk. */
const MAX_ERROR_STACK_CHARS = 2000;
/** Agent references are user-controlled text; bound them like any other input. */
const MAX_AGENT_REF_CHARS = 120;

export interface RedactedErrorFacts {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorStack?: string;
}

/**
 * Projects an unknown throwable onto `name` / `message` / `stack` only.
 *
 * Deliberately not generic error serialization: `AgentConfigError`,
 * provider SDK errors and `fetch` failures all hang extra fields (request
 * bodies, headers, parsed config) off the error, and those must never reach a
 * log file.
 */
export function redactedErrorFacts(error: unknown): RedactedErrorFacts {
  if (!(error instanceof Error)) {
    // Keep the shape stable so log consumers do not need a second branch, and
    // record only the primitive type — the value itself may be a config object.
    return { errorName: 'NonError', errorMessage: `non-Error throwable (${typeof error})` };
  }
  const stack = typeof error.stack === 'string' ? error.stack : undefined;
  return {
    errorName: error.name || 'Error',
    errorMessage: truncate(error.message, MAX_ERROR_MESSAGE_CHARS),
    ...(stack === undefined ? {} : { errorStack: truncate(stack, MAX_ERROR_STACK_CHARS) }),
  };
}

/** Bounds an Agent name/requestRef before it is used as a log field. */
export function redactedAgentRef(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? truncate(trimmed, MAX_AGENT_REF_CHARS) : undefined;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`;
}
