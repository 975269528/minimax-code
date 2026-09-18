import type {
  AgentHostTurnCapabilityView as DesktopTurnCapabilityView,
  AgentHostTurnRuntimeToolBinding as DesktopTurnRuntimeToolBinding,
  AgentHostTurnToolMode as DesktopTurnToolMode,
} from '../../turn-system/index.js';
import { AgentToolMode } from '@mavis/protocol';

import {
  ConnectorCloudClient,
  type CallConnectorToolResult,
  type ConnectedConnectorTool,
  type ConnectedConnectorToolsResult,
} from './cloud-client.js';

type DesktopRuntimeTool = DesktopTurnCapabilityView['runtimeTools'][number];

export interface ConnectorRuntimeLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ConnectorRuntimeMetrics {
  incr(name: string, tags?: Record<string, string>): void;
  latency(name: string, durationMs: number, tags?: Record<string, string>): void;
}

export interface ConnectorRuntimePort {
  resolveForTurn(signal?: AbortSignal): Promise<readonly DesktopRuntimeTool[]>;
  resolveBindingsForTurn?(signal?: AbortSignal): Promise<readonly DesktopTurnRuntimeToolBinding[]>;
}

export const EMPTY_CONNECTOR_RUNTIME: ConnectorRuntimePort = {
  resolveForTurn: async () => freeze([]),
  resolveBindingsForTurn: async () => freeze([]),
};

export interface DesktopConnectorRuntimeOptions {
  readonly client: ConnectorCloudClient;
  readonly logger?: ConnectorRuntimeLogger;
  readonly metrics?: ConnectorRuntimeMetrics;
  readonly nowMs?: () => number;
  readonly scopeKeyGetter?: () => string;
}

/** Resolves a fresh Connector inventory for each callable Desktop turn. */
export class DesktopConnectorRuntime implements ConnectorRuntimePort {
  private readonly logger: ConnectorRuntimeLogger;
  private readonly metrics: ConnectorRuntimeMetrics | undefined;
  private resolveFailure: ConnectorResolveFailure | undefined;
  private authGeneration = 0;
  private resolveRequestSequence = 0;

  constructor(private readonly options: DesktopConnectorRuntimeOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.metrics = options.metrics;
  }

  async resolveForTurn(signal?: AbortSignal): Promise<readonly DesktopRuntimeTool[]> {
    return freeze((await this.resolveBindingsForTurn(signal)).map((binding) => binding.tool));
  }

  /** Authentication rotation must never inherit a previous token's failure cooldown. */
  authContextChanged(): void {
    this.authGeneration += 1;
    this.resolveFailure = undefined;
  }

  async resolveBindingsForTurn(
    signal?: AbortSignal,
  ): Promise<readonly DesktopTurnRuntimeToolBinding[]> {
    const scopeKey = this.options.scopeKeyGetter?.() ?? DEFAULT_CONNECTOR_SCOPE_KEY;
    const authGeneration = this.authGeneration;
    if (this.isResolveCircuitOpen(scopeKey)) {
      this.metrics?.incr('desktop_connector_resolve_total', { status: 'circuit_open' });
      return freeze([]);
    }

    const requestId = ++this.resolveRequestSequence;
    const result = await this.requestConnectedTools(scopeKey, authGeneration, requestId, signal);
    if (!result) return freeze([]);
    this.metrics?.incr('desktop_connector_resolve_total', {
      status: result.partial ? 'partial' : 'ok',
    });
    for (const failure of result.providerFailures) {
      this.metrics?.incr('desktop_connector_provider_failure_total', {
        provider: failure.provider,
        code: failure.code,
      });
      this.logger.warn('Desktop Connector provider resolve failed', {
        provider: failure.provider,
        code: failure.code,
        retryable: failure.retryable,
      });
    }

    const names = new Set<string>();
    const bindings: DesktopTurnRuntimeToolBinding[] = [];
    for (const descriptor of result.tools) {
      const key = collisionKey(descriptor.runtimeToolName);
      // Keep only the first tool with a given name each turn, preventing later providers from silently overwriting it.
      if (!key || names.has(key)) {
        this.metrics?.incr('desktop_connector_tool_skipped_total', { reason: 'name_conflict' });
        continue;
      }
      names.add(key);
      bindings.push(
        freeze({
          kind: 'app',
          source: descriptor.provider,
          // RuntimeTool is shared by all tools; Connector-specific state travels with the binding to final assembly.
          toolMode: normalizeToolMode(descriptor.agentToolMode),
          tool: this.runtimeTool(descriptor),
        }),
      );
    }
    return freeze(bindings);
  }

  private nowMs(): number {
    return this.options.nowMs?.() ?? Date.now();
  }

  private async requestConnectedTools(
    scopeKey: string,
    authGeneration: number,
    requestId: number,
    signal: AbortSignal | undefined,
  ): Promise<ConnectedConnectorToolsResult | undefined> {
    try {
      // Connector authorization can change at any time, so refetch the current user's tools for every executable turn.
      const result = await this.options.client.listConnectedTools(signal);
      if (!this.isAuthRequestCurrent(scopeKey, authGeneration)) return undefined;
      if (requestId === this.resolveRequestSequence) this.resolveFailure = undefined;
      return result;
    } catch (error) {
      if (!this.isAuthRequestCurrent(scopeKey, authGeneration)) return undefined;
      if (errorCode(error) === 'AUTH_REQUIRED') {
        this.metrics?.incr('desktop_connector_resolve_total', { status: 'unauthenticated' });
        if (requestId === this.resolveRequestSequence) this.resolveFailure = undefined;
        return undefined;
      }
      if (requestId === this.resolveRequestSequence) this.recordResolveFailure(scopeKey, error);
      this.metrics?.incr('desktop_connector_resolve_total', { status: 'error' });
      this.logger.warn('Desktop Connector tools resolve failed', { errorType: errorType(error) });
      return undefined;
    }
  }

  private isResolveCircuitOpen(scopeKey: string): boolean {
    if (this.resolveFailure?.scopeKey !== scopeKey) this.resolveFailure = undefined;
    return this.resolveFailure !== undefined && this.nowMs() < this.resolveFailure.retryAtMs;
  }

  private recordResolveFailure(scopeKey: string, error: unknown): void {
    this.resolveFailure = shouldBackoff(error)
      ? nextResolveFailure(scopeKey, this.resolveFailure, this.nowMs())
      : undefined;
  }

  private isAuthRequestCurrent(scopeKey: string, authGeneration: number): boolean {
    const currentScopeKey = this.options.scopeKeyGetter?.() ?? DEFAULT_CONNECTOR_SCOPE_KEY;
    return authGeneration === this.authGeneration && scopeKey === currentScopeKey;
  }

  private runtimeTool(descriptor: ConnectedConnectorTool): DesktopRuntimeTool {
    const name = descriptor.runtimeToolName;
    return freeze({
      def: freeze({
        name,
        description:
          descriptor.description ??
          `Call ${descriptor.providerToolName} from Connector ${descriptor.provider}.`,
        schema: parseToolSchema(descriptor.inputSchemaJson),
      }) as DesktopRuntimeTool['def'],
      impl: freeze({
        execute: async (context, input, signal) => {
          let result: CallConnectorToolResult;
          try {
            result = await this.options.client.callTool({
              provider: descriptor.provider,
              providerToolName: descriptor.providerToolName,
              runtimeToolName: name,
              arguments: toRecord(input),
              sessionId: context.sessionId,
              turnId: context.turnId,
              toolCallId: context.toolCallId,
              requestId: context.toolCallId ?? `${context.sessionId}:${context.turnId}:${name}`,
              ...(signal ? { signal } : {}),
            });
          } catch (error) {
            this.metrics?.incr('desktop_connector_call_total', { status: 'error' });
            throw error;
          }
          const status = result.isError === true ? 'provider_error' : 'ok';
          this.metrics?.incr('desktop_connector_call_total', { status });
          if (result.latencyMs !== undefined) {
            this.metrics?.latency('desktop_connector_call_latency_ms', result.latencyMs, {
              status,
            });
          }
          return formatToolResult(descriptor, result);
        },
      }),
      source: 'configured',
    });
  }
}

function normalizeToolMode(value: unknown): DesktopTurnToolMode {
  // Recognize only the two values that change legacy behavior; empty, absent, and future unknown values remain inline.
  if (value === AgentToolMode.OMIT) return 'omit';
  if (value === AgentToolMode.TOOL_SEARCH) return 'tool_search';
  return 'inline';
}

function parseToolSchema(value: string): DesktopRuntimeTool['def']['schema'] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return freeze({
        ...(parsed as Record<string, unknown>),
      }) as DesktopRuntimeTool['def']['schema'];
    }
  } catch {
    // The BFF validates catalog data; a malformed entry must not break the turn.
  }
  const fallback: Record<string, unknown> = { type: 'object', properties: {} };
  return freeze({ ...fallback }) as DesktopRuntimeTool['def']['schema'];
}

function formatToolResult(descriptor: ConnectedConnectorTool, result: CallConnectorToolResult) {
  const isError = result.isError === true;
  const text =
    isError && result.errorMessage
      ? result.errorMessage
      : (result.resultJson ?? (isError ? 'Connector tool returned an error.' : ''));
  return {
    tool_name: descriptor.runtimeToolName,
    text,
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
    details: {
      is_error: isError,
      error_code: result.errorCode,
      error_message: result.errorMessage,
      latency_ms: result.latencyMs,
      provider_usage_json: result.providerUsageJson,
      app: {
        provider: descriptor.provider,
        display_name: descriptor.providerDisplayName ?? descriptor.provider,
        ...(descriptor.providerLogoUrl ? { icon_url: descriptor.providerLogoUrl } : {}),
        tool: descriptor.providerToolName,
      },
    },
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function collisionKey(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = Reflect.get(error, 'status');
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

function shouldBackoff(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'NETWORK_ERROR' || code === 'REQUEST_TIMEOUT') return true;
  if (code !== 'HTTP_ERROR') return false;
  const status = errorStatus(error);
  return status === 429 || (status !== undefined && status >= 500);
}

interface ConnectorResolveFailure {
  readonly scopeKey: string;
  readonly failureCount: number;
  readonly retryAtMs: number;
}

function nextResolveFailure(
  scopeKey: string,
  prior: ConnectorResolveFailure | undefined,
  nowMs: number,
): ConnectorResolveFailure {
  const failureCount = prior?.scopeKey === scopeKey ? prior.failureCount + 1 : 1;
  const retryDelayMs = Math.min(10_000 * 2 ** (failureCount - 1), 30_000);
  return { scopeKey, failureCount, retryAtMs: nowMs + retryDelayMs };
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

const NOOP_LOGGER: ConnectorRuntimeLogger = { warn: () => undefined };
const DEFAULT_CONNECTOR_SCOPE_KEY = 'default';
