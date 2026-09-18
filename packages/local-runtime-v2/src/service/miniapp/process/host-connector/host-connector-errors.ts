import { ConnectorGatewayError } from '../../../host-connector-system/index.js';

export type HostConnectorDisposition =
  | 'not_dispatched'
  | 'provider_reported'
  | 'unknown_after_dispatch';

export interface HostConnectorDiagnosticIssue {
  readonly path: string;
  readonly constraint: string;
  readonly limit?: number;
}

export interface HostConnectorDiagnostic {
  readonly issues: readonly HostConnectorDiagnosticIssue[];
}

export class HostConnectorError extends Error {
  override readonly name = 'HostConnectorError';

  constructor(
    readonly code: string,
    message: string,
    readonly disposition: HostConnectorDisposition,
    options: {
      readonly retryable: boolean;
      readonly invocationId?: string;
      readonly diagnostic?: HostConnectorDiagnostic;
    },
  ) {
    super(message);
    this.retryable = options.retryable;
    this.invocationId = options.invocationId;
    if (options.diagnostic) this.diagnostic = options.diagnostic;
  }

  readonly retryable: boolean;
  readonly invocationId?: string;
  declare readonly diagnostic?: HostConnectorDiagnostic;
}

export class HostConnectorRequestTimeoutError extends Error {
  override readonly name = 'HostConnectorRequestTimeoutError';
}

export class HostConnectorCancelledError extends Error {
  override readonly name = 'HostConnectorCancelledError';
}

export interface HostConnectorWireError {
  readonly code: string;
  readonly message: string;
  readonly disposition: HostConnectorDisposition;
  readonly retryable: boolean;
  readonly invocationId?: string;
  readonly diagnostic?: HostConnectorDiagnostic;
}

export function normalizeGatewayError(
  error: unknown,
  fallbackInvocationId?: string,
  gatewayPromiseObtained = false,
): HostConnectorWireError {
  if (error instanceof ConnectorGatewayError) {
    return normalizeTypedGatewayError(error, fallbackInvocationId);
  }
  if (error instanceof HostConnectorRequestTimeoutError) {
    return gatewayPromiseObtained && fallbackInvocationId
      ? unknownWireError(fallbackInvocationId, 'CONNECTOR_OUTCOME_UNKNOWN')
      : timeoutWireError(fallbackInvocationId);
  }
  if (error instanceof HostConnectorCancelledError) {
    return gatewayPromiseObtained && fallbackInvocationId
      ? unknownWireError(fallbackInvocationId, 'CONNECTOR_OUTCOME_UNKNOWN')
      : cancelledWireError(fallbackInvocationId);
  }
  return gatewayPromiseObtained && fallbackInvocationId
    ? unknownWireError(fallbackInvocationId, 'CONNECTOR_OUTCOME_UNKNOWN')
    : withInvocationId(
        unavailableWireError(fallbackInvocationId !== undefined),
        fallbackInvocationId,
      );
}

export function unavailableWireError(retryable = false): HostConnectorWireError {
  return {
    code: 'CONNECTOR_UNAVAILABLE',
    message: 'Host Connector calls are unavailable for this generation',
    disposition: 'not_dispatched',
    retryable,
  };
}

export function serviceRestartedWireError(invocationId?: string): HostConnectorWireError {
  return {
    code: 'SERVICE_RESTARTED',
    message: 'Mini App service restarted before Connector dispatch',
    disposition: 'not_dispatched',
    retryable: true,
    ...(invocationId ? { invocationId } : {}),
  };
}

export function staleToolWireError(): HostConnectorWireError {
  return {
    code: 'TOOL_REF_STALE',
    message: 'Host Connector tool reference is stale',
    disposition: 'not_dispatched',
    retryable: false,
  };
}

export function providerWireError(invocationId?: string): HostConnectorWireError {
  return {
    code: 'CONNECTOR_PROVIDER_ERROR',
    message: 'Connector provider reported an error',
    disposition: 'provider_reported',
    retryable: false,
    ...(invocationId ? { invocationId } : {}),
  };
}

function normalizeTypedGatewayError(
  error: ConnectorGatewayError,
  fallbackInvocationId?: string,
): HostConnectorWireError {
  if (isInvalidArgumentsGatewayError(error)) {
    return invalidArgumentsWireError(error, fallbackInvocationId);
  }
  if (error.code === 'CONNECTOR_PRINCIPAL_CHANGED' && error.outcome === 'not_dispatched') {
    return withInvocationId(staleToolWireError(), fallbackInvocationId);
  }
  return normalizeOtherTypedGatewayError(error, fallbackInvocationId);
}

function normalizeOtherTypedGatewayError(
  error: ConnectorGatewayError,
  fallbackInvocationId?: string,
): HostConnectorWireError {
  if (error.outcome === 'unknown_after_dispatch') {
    return unknownWireError(
      error.invocationId ?? fallbackInvocationId ?? 'unknown',
      'CONNECTOR_OUTCOME_UNKNOWN',
    );
  }
  if (error.outcome === 'provider_reported') {
    return providerWireError(error.invocationId ?? fallbackInvocationId);
  }
  if (error.code === 'REQUEST_ABORTED') {
    return withInvocationId(
      {
        code: 'REQUEST_CANCELLED',
        message: 'Connector request was cancelled',
        disposition: 'not_dispatched',
        retryable: false,
      },
      fallbackInvocationId,
    );
  }
  return withInvocationId(
    unavailableWireError(
      error.code === 'CONNECTOR_AUDIT_UNAVAILABLE' || error.code === 'CONNECTOR_CALL_FAILED',
    ),
    fallbackInvocationId,
  );
}

function isInvalidArgumentsGatewayError(error: ConnectorGatewayError): boolean {
  return error.code === 'CONNECTOR_ARGUMENTS_INVALID' && error.outcome === 'not_dispatched';
}

function invalidArgumentsWireError(
  error: ConnectorGatewayError,
  fallbackInvocationId?: string,
): HostConnectorWireError {
  const invocationId = error.invocationId ?? fallbackInvocationId;
  const diagnostic = projectGatewayDiagnostic(error);
  return {
    code: 'INVALID_ARGUMENTS',
    message: 'Connector arguments are invalid',
    disposition: 'not_dispatched',
    retryable: false,
    ...(invocationId ? { invocationId } : {}),
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function projectGatewayDiagnostic(
  error: ConnectorGatewayError,
): HostConnectorDiagnostic | undefined {
  const diagnostic = error.diagnostic;
  if (!isRecord(diagnostic) || !Array.isArray(diagnostic.issues)) return undefined;
  const issues: HostConnectorDiagnosticIssue[] = [];
  for (const candidate of diagnostic.issues.slice(0, 4)) {
    const issue = projectDiagnosticIssue(candidate);
    if (issue) issues.push(issue);
  }
  return issues.length > 0 ? { issues } : undefined;
}

function projectDiagnosticIssue(value: unknown): HostConnectorDiagnosticIssue | undefined {
  if (
    !isRecord(value) ||
    !isSafeHostConnectorDiagnosticPath(value.path) ||
    !isSafeHostConnectorDiagnosticConstraint(value.constraint)
  ) {
    return undefined;
  }
  if ('limit' in value && (typeof value.limit !== 'number' || !Number.isFinite(value.limit))) {
    return undefined;
  }
  return {
    path: value.path,
    constraint: value.constraint,
    ...('limit' in value ? { limit: value.limit as number } : {}),
  };
}

export function isSafeHostConnectorDiagnosticPath(value: unknown): value is string {
  if (!isBoundedJsonPointerString(value)) return false;
  if (!hasSafeJsonPointerCharacters(value)) return false;
  return hasOnlyUnicodeScalars(value);
}

function isBoundedJsonPointerString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value) <= 256 &&
    (value === '' || value.startsWith('/'))
  );
}

function hasSafeJsonPointerCharacters(value: string): boolean {
  return !/\p{Cc}/u.test(value) && !/~(?![01])/u.test(value);
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

export function isSafeHostConnectorDiagnosticConstraint(value: unknown): value is string {
  return (
    typeof value === 'string' && Buffer.byteLength(value) <= 64 && /^[A-Za-z0-9_.~-]+$/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cancelledWireError(invocationId?: string): HostConnectorWireError {
  return {
    code: 'REQUEST_CANCELLED',
    message: 'Connector request was cancelled',
    disposition: 'not_dispatched',
    retryable: false,
    ...(invocationId ? { invocationId } : {}),
  };
}

function timeoutWireError(invocationId?: string): HostConnectorWireError {
  return {
    code: 'CONNECTOR_TIMEOUT',
    message: 'Host Connector request timed out',
    disposition: 'not_dispatched',
    retryable: true,
    ...(invocationId ? { invocationId } : {}),
  };
}

function unknownWireError(invocationId: string, code: string): HostConnectorWireError {
  return {
    code,
    message: 'Connector outcome is unknown after dispatch',
    disposition: 'unknown_after_dispatch',
    retryable: false,
    invocationId,
  };
}

function withInvocationId(
  error: HostConnectorWireError,
  invocationId?: string,
): HostConnectorWireError {
  return invocationId ? { ...error, invocationId } : error;
}
