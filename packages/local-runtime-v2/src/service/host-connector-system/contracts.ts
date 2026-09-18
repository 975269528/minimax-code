interface ConnectorProviderFailure {
  readonly provider: string;
  readonly code: string;
  readonly retryable?: boolean;
}

export interface ConnectorCredentialSnapshot {
  readonly accessToken: string;
  readonly realUserID: string;
}

export interface CallConnectorToolResult {
  readonly resultJson?: string;
  readonly isError?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly latencyMs?: number;
  readonly providerUsageJson?: string;
}

declare const CONNECTOR_TOOL_HANDLE: unique symbol;

/** Host-owned capability. Its provider/tool routing is kept in a private WeakMap. */
export type ConnectorToolHandle = Readonly<{
  readonly [CONNECTOR_TOOL_HANDLE]: true;
}>;

export interface ConnectorInventoryTool {
  readonly handle: ConnectorToolHandle;
  readonly provider: string;
  readonly providerToolName: string;
  readonly runtimeToolName: string;
  readonly description?: string;
  readonly inputSchemaJson: string;
  readonly outputSchemaJson?: string;
  readonly agentToolMode?: number;
}

export interface ConnectorInventory {
  readonly tools: readonly ConnectorInventoryTool[];
  readonly providerFailures: readonly ConnectorProviderFailure[];
  readonly partial: boolean;
}

export type ConnectedConnectorTool = Omit<ConnectorInventoryTool, 'handle'>;

interface ConnectedConnectorProviderFailure {
  readonly provider: string;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

interface ConnectedConnectorToolsResult {
  readonly tools: readonly ConnectedConnectorTool[];
  readonly providerFailures: readonly ConnectedConnectorProviderFailure[];
  readonly partial: boolean;
}

/** Host-internal client seam implemented by the existing PluginSystem Cloud adapter. */
export interface HostProcessConnectorCloudClient {
  listConnectedTools(input: {
    readonly credential: ConnectorCredentialSnapshot;
    readonly signal?: AbortSignal;
  }): Promise<ConnectedConnectorToolsResult>;
  /**
   * Must synchronously either fail preflight or enter transport dispatch before
   * yielding. The Gateway performs its final capability fence immediately before
   * invoking this method.
   */
  callTool(input: {
    readonly credential: ConnectorCredentialSnapshot;
    readonly provider: string;
    readonly providerToolName: string;
    readonly runtimeToolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly toolCallId?: string;
    readonly requestId: string;
    readonly traceId?: string;
    readonly signal?: AbortSignal;
    /** Called immediately after the transport returns its response promise. */
    readonly onDispatch: () => void;
  }): Promise<CallConnectorToolResult>;
}

export interface HostProcessConnectorCaller {
  readonly kind: 'host-process';
  readonly pluginId: string;
  readonly processGeneration: string;
}

export interface ConnectorHostRequestContext {
  readonly clientRequestId: string;
  readonly invocationId: string;
}

export type ConnectorCallOutcome =
  | 'not_dispatched'
  | 'completed'
  | 'provider_reported'
  | 'unknown_after_dispatch';

/** Host-process boundary owned by local-runtime-v2. Ordinary Desktop turns do not use this seam. */
export interface HostProcessConnectorGateway {
  /** Registers the generation before its child process can issue Connector requests. */
  registerHostProcess(input: {
    readonly pluginId: string;
    readonly processGeneration: string;
  }): void;
  list(input: {
    readonly providerAllowlist: readonly string[];
    readonly caller: HostProcessConnectorCaller;
    readonly signal?: AbortSignal;
  }): Promise<ConnectorInventory>;
  call(input: {
    readonly handle: ConnectorToolHandle;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly caller: HostProcessConnectorCaller;
    readonly hostRequest: ConnectorHostRequestContext;
    readonly signal?: AbortSignal;
  }): Promise<CallConnectorToolResult>;
  releaseHostProcess(input: {
    readonly pluginId: string;
    readonly processGeneration: string;
  }): void;
}
