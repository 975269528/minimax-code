import type { ConnectorCallOutcome } from './contracts.js';

export interface ConnectorArgumentsDiagnosticIssue {
  readonly path: string;
  readonly constraint: string;
  readonly limit?: number;
}

export interface ConnectorGatewayDiagnostic {
  readonly issues: readonly ConnectorArgumentsDiagnosticIssue[];
}

interface ConnectorGatewayErrorDetails {
  readonly invocationId?: string;
  readonly diagnostic?: ConnectorGatewayDiagnostic;
}

export class ConnectorGatewayError extends Error {
  readonly invocationId?: string;
  readonly diagnostic?: ConnectorGatewayDiagnostic;

  constructor(
    readonly code: string,
    message: string,
    readonly outcome: ConnectorCallOutcome,
    invocationIdOrDetails?: string | ConnectorGatewayErrorDetails,
  ) {
    super(message);
    this.name = 'ConnectorGatewayError';
    this.invocationId =
      typeof invocationIdOrDetails === 'string'
        ? invocationIdOrDetails
        : invocationIdOrDetails?.invocationId;
    this.diagnostic =
      typeof invocationIdOrDetails === 'string' ? undefined : invocationIdOrDetails?.diagnostic;
  }
}
