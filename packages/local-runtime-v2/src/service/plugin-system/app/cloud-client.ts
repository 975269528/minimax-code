import { AgentToolMode } from '@mavis/protocol';

import type {
  ConnectorCredentialSnapshot,
  HostProcessConnectorCloudClient,
} from '../../host-connector-system/index.js';
import { PluginSystemCloudTransport, PluginSystemCloudTransportError } from '../cloud-transport.js';

const CONNECTOR_BASE = '/minimax-cloud/api/v1/connectors';
// Tool discovery runs before every Desktop turn. It is fail-open in the
// runtime, so keep this budget short enough that a slow Cloud dependency does
// not make message sending appear stuck.
const CONNECTOR_TOOL_LIST_TIMEOUT_MS = 5_000;
const CONNECTOR_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConnectedConnectorTool {
  readonly provider: string;
  readonly providerDisplayName?: string;
  readonly providerLogoUrl?: string;
  readonly providerToolName: string;
  readonly runtimeToolName: string;
  readonly description?: string;
  readonly inputSchemaJson: string;
  readonly outputSchemaJson?: string;
  readonly agentToolMode?: AgentToolMode;
}

interface ConnectorProviderFailure {
  readonly provider: string;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface ConnectedConnectorToolsResult {
  readonly tools: readonly ConnectedConnectorTool[];
  readonly providerFailures: readonly ConnectorProviderFailure[];
  readonly partial: boolean;
}

export interface CallConnectorToolInput {
  readonly provider: string;
  readonly providerToolName: string;
  readonly runtimeToolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly toolCallId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly signal?: AbortSignal;
}

export interface CallConnectorToolResult {
  readonly resultJson?: string;
  readonly isError?: boolean;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly latencyMs?: number;
  readonly providerUsageJson?: string;
}

/** Existing CloudConnectorService client used directly by Desktop turns. */
export class ConnectorCloudClient {
  constructor(private readonly transport: PluginSystemCloudTransport) {}

  listConnectedTools(signal?: AbortSignal): Promise<ConnectedConnectorToolsResult> {
    return this.requestConnectedTools(signal);
  }

  callTool(input: CallConnectorToolInput): Promise<CallConnectorToolResult> {
    return this.requestToolCall(input);
  }

  /** Explicit credential adapter reserved for the Host-process Connector boundary. */
  asHostProcessClient(): HostProcessConnectorCloudClient {
    return {
      listConnectedTools: (input) => this.requestConnectedTools(input.signal, input.credential),
      callTool: (input) => this.requestToolCall(input, input.credential, input.onDispatch),
    };
  }

  private async requestConnectedTools(
    signal?: AbortSignal,
    credential?: ConnectorCredentialSnapshot,
  ): Promise<ConnectedConnectorToolsResult> {
    const payload = await this.transport.request({
      method: 'POST',
      path: `${CONNECTOR_BASE}/connected-tools/list`,
      auth: 'required',
      ...(credential ? { authContext: credential } : {}),
      timeoutMs: CONNECTOR_TOOL_LIST_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    const record = requireRecord(payload, 'Connector tools response');
    return freeze({
      tools: freeze(readArray(record, 'tools', 'tools').map(readTool)),
      providerFailures: freeze(
        readArray(record, 'provider_failures', 'providerFailures').map(readProviderFailure),
      ),
      partial: requireBoolean(record, 'partial', 'partial'),
    });
  }

  private async requestToolCall(
    input: CallConnectorToolInput,
    credential?: ConnectorCredentialSnapshot,
    onDispatch?: () => void,
  ): Promise<CallConnectorToolResult> {
    const argumentsJson = JSON.stringify(input.arguments);
    const payload = await this.transport.request({
      method: 'POST',
      path: `${CONNECTOR_BASE}/tools/call`,
      auth: 'required',
      ...(credential ? { authContext: credential } : {}),
      timeoutMs: CONNECTOR_TOOL_CALL_TIMEOUT_MS,
      body: {
        provider: input.provider,
        provider_tool_name: input.providerToolName,
        runtime_tool_name: input.runtimeToolName,
        arguments_json: argumentsJson,
        session_id: input.sessionId,
        turn_id: input.turnId,
        tool_call_id: input.toolCallId,
        request_id: input.requestId,
        trace_id: input.traceId,
      },
      ...(onDispatch ? { onDispatch } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const record = requireRecord(payload, 'Connector tool call response');
    return freeze({
      ...optionalString(record, 'result_json', 'resultJson', 'resultJson'),
      ...optionalBoolean(record, 'is_error', 'isError', 'isError'),
      ...optionalString(record, 'error_code', 'errorCode', 'errorCode'),
      ...optionalString(record, 'error_message', 'errorMessage', 'errorMessage'),
      ...optionalNumber(record, 'latency_ms', 'latencyMs', 'latencyMs'),
      ...optionalString(record, 'provider_usage_json', 'providerUsageJson', 'providerUsageJson'),
    });
  }
}

function readTool(value: unknown): ConnectedConnectorTool {
  const record = requireRecord(value, 'Connector tool');
  // agent_tool_mode is optional and may explicitly be null; subsequent logic treats both cases as inline.
  return freeze({
    provider: requireString(record, 'provider', 'provider'),
    ...optionalString(
      record,
      'provider_display_name',
      'providerDisplayName',
      'providerDisplayName',
    ),
    ...optionalString(record, 'provider_logo_url', 'providerLogoUrl', 'providerLogoUrl'),
    providerToolName: requireString(record, 'provider_tool_name', 'providerToolName'),
    runtimeToolName: requireString(record, 'runtime_tool_name', 'runtimeToolName'),
    ...optionalString(record, 'description', 'description', 'description'),
    inputSchemaJson: requireString(record, 'input_schema_json', 'inputSchemaJson'),
    ...optionalString(record, 'output_schema_json', 'outputSchemaJson', 'outputSchemaJson'),
    ...optionalAgentToolMode(record),
  });
}

function optionalAgentToolMode(
  record: Record<string, unknown>,
): Partial<Pick<ConnectedConnectorTool, 'agentToolMode'>> {
  const value = field(record, 'agent_tool_mode', 'agentToolMode');
  // For optional enums, null is equivalent to absence; runtime compatibility handles unknown numbers as INLINE.
  if (value === undefined || value === null) return {};
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid('agent_tool_mode');
  return { agentToolMode: value as AgentToolMode };
}

function readProviderFailure(value: unknown): ConnectorProviderFailure {
  const record = requireRecord(value, 'Connector provider failure');
  return freeze({
    provider: requireString(record, 'provider', 'provider'),
    code: requireString(record, 'code', 'code'),
    message: requireString(record, 'message', 'message'),
    ...optionalBoolean(record, 'retryable', 'retryable', 'retryable'),
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(label);
  return value as Record<string, unknown>;
}

function field(record: Record<string, unknown>, snake: string, camel: string): unknown {
  return record[snake] ?? record[camel];
}

function readArray(record: Record<string, unknown>, snake: string, camel: string): unknown[] {
  const value = field(record, snake, camel);
  if (!Array.isArray(value)) invalid(snake);
  return value;
}

function requireString(record: Record<string, unknown>, snake: string, camel: string): string {
  const value = field(record, snake, camel);
  if (typeof value !== 'string') invalid(snake);
  return value;
}

function requireBoolean(record: Record<string, unknown>, snake: string, camel: string): boolean {
  const value = field(record, snake, camel);
  if (typeof value !== 'boolean') invalid(snake);
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
  output: string,
): Record<string, string> {
  const value = field(record, snake, camel);
  // For optional fields, null is equivalent to absence; do not mistake server nulls for invalid responses.
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') invalid(snake);
  return { [output]: value };
}

function optionalBoolean(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
  output: string,
): Record<string, boolean> {
  const value = field(record, snake, camel);
  if (value === undefined || value === null) return {};
  if (typeof value !== 'boolean') invalid(snake);
  return { [output]: value };
}

function optionalNumber(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
  output: string,
): Record<string, number> {
  const value = field(record, snake, camel);
  if (value === undefined || value === null) return {};
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(snake);
  return { [output]: value };
}

function invalid(label: string): never {
  throw new PluginSystemCloudTransportError('RESPONSE_INVALID', `${label} is invalid`);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
