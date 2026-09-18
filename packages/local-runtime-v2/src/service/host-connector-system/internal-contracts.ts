import type {
  ConnectorCallOutcome,
  HostProcessConnectorCloudClient,
  HostProcessConnectorGateway,
} from './contracts.js';

export interface ConnectorAuditEvent {
  readonly phase: 'admission' | 'terminal';
  readonly timestampMs: number;
  readonly invocationId: string;
  readonly principalEpoch: number;
  readonly inventoryRevision: number;
  readonly callerKind: 'host-process';
  readonly pluginId?: string;
  readonly processGeneration?: string;
  readonly clientRequestId?: string;
  readonly provider: string;
  readonly tool: string;
  readonly outcome?: ConnectorCallOutcome;
  readonly code?: string;
  readonly durationMs?: number;
}

interface ConnectorAudit {
  record(event: ConnectorAuditEvent): void | Promise<void>;
}

export interface ConnectorGatewayOptions {
  readonly client: HostProcessConnectorCloudClient;
  readonly credentialGetter: () =>
    | {
        readonly accessToken?: string;
        readonly realUserID?: string;
        readonly authState?: 'pending' | 'authenticated' | 'logged_out';
      }
    | undefined;
  readonly audit?: ConnectorAudit;
  readonly onAuditFailure?: (error: unknown) => void;
  readonly nowMs?: () => number;
  readonly drainTimeoutMs?: number;
}

export interface HostConnectorSystemOptions extends ConnectorGatewayOptions {
  readonly audit: ConnectorAudit;
}

export interface InitializedHostConnectorSystem {
  readonly gateway: HostProcessConnectorGateway;
  authContextChanged(): void;
  close(): Promise<void>;
}
