import type {
  LocalWebsiteDeployAdapterFailure,
  LocalWebsiteDeployFailureReason,
  LocalWebsiteDeployStage,
} from '@mavis/agent-tools/desktop';

const RETRYABLE_NODE_ERRNOS = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

export class WebsiteDeployAdapterFailure extends Error implements LocalWebsiteDeployAdapterFailure {
  readonly reason: LocalWebsiteDeployFailureReason;
  readonly stage: LocalWebsiteDeployStage;
  readonly retryable: boolean;

  constructor(
    message: string,
    details: {
      reason: LocalWebsiteDeployFailureReason;
      stage: LocalWebsiteDeployStage;
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = 'WebsiteDeployAdapterFailure';
    this.reason = details.reason;
    this.stage = details.stage;
    this.retryable = details.retryable;
  }
}

export function ensureNotAborted(
  signal: AbortSignal | undefined,
  phase: string,
  stage: LocalWebsiteDeployStage,
): void {
  if (signal?.aborted) {
    throw deployFailure(`website_deploy aborted ${phase}`, 'aborted', stage);
  }
}

export async function runDeployStage<T>(
  step: LocalWebsiteDeployStage,
  upstreamSignal: AbortSignal | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WebsiteDeployAdapterFailure) throw err;
    if (upstreamSignal?.aborted) throw deployFailure(describeError(err), 'aborted', step);
    const retryable =
      isNetworkDeployStage(step) && (isAbortError(err) || isRetryableTransportFailure(err));
    const detail = describeErrorWithCause(err);
    throw deployFailure(
      `website_deploy ${step} failed: ${detail}`,
      retryable ? 'transport_failed' : failureReasonForDeployStage(step),
      step,
      retryable,
    );
  }
}

export function deployFailure(
  message: string,
  reason: LocalWebsiteDeployFailureReason,
  stage: LocalWebsiteDeployStage,
  retryable = false,
): WebsiteDeployAdapterFailure {
  return new WebsiteDeployAdapterFailure(message, { reason, stage, retryable });
}

function failureReasonForDeployStage(
  stage: LocalWebsiteDeployStage,
): LocalWebsiteDeployFailureReason {
  if (stage === 'validate_site' || stage === 'validate_source') return 'validation_failed';
  if (stage === 'upload_site' || stage === 'upload_source') return 'packaging_failed';
  return 'service_request_failed';
}

function isNetworkDeployStage(stage: LocalWebsiteDeployStage): boolean {
  return (
    stage === 'get_upload_url' ||
    stage === 'get_upload_url_source' ||
    stage === 'upload_archive' ||
    stage === 'upload_source_archive' ||
    stage === 'publish_archive' ||
    stage === 'update_archive'
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function isRetryableTransportFailure(err: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = err;
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (
      hasRetryableNodeErrno(current) ||
      isFetchFailure(current) ||
      isRetryableMatrixHttpError(current)
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

function hasRetryableNodeErrno(err: object): boolean {
  return 'code' in err && typeof err.code === 'string' && RETRYABLE_NODE_ERRNOS.has(err.code);
}

function isFetchFailure(err: object): boolean {
  return err instanceof TypeError && err.message === 'fetch failed';
}

function isRetryableMatrixHttpError(err: object): boolean {
  if (!(err instanceof Error)) return false;
  return (
    /^Matrix backend \S+ HTTP (?:502|503|504):/u.test(err.message) ||
    /^Matrix upload PUT HTTP (?:502|503|504):/u.test(err.message)
  );
}

function describeErrorWithCause(err: unknown): string {
  const primary = describeError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) return primary;
  return `${primary}; cause=${describeError(cause)}`;
}

function describeError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error';
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  return String(err);
}
