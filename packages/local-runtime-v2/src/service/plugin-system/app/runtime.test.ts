import { AgentToolMode } from '@mavis/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectedConnectorToolsResult, ConnectorCloudClient } from './cloud-client.js';
import { DesktopConnectorRuntime } from './runtime.js';

describe('DesktopConnectorRuntime', () => {
  it('preserves provider provenance beside each resolved runtime tool', async () => {
    const runtime = new DesktopConnectorRuntime({
      client: {
        listConnectedTools: vi.fn(async () => ({
          tools: [
            {
              provider: 'notion',
              providerToolName: 'search',
              runtimeToolName: 'notion_search',
              inputSchemaJson: '{}',
              agentToolMode: AgentToolMode.TOOL_SEARCH,
            },
          ],
          providerFailures: [],
          partial: false,
        })),
        callTool: vi.fn(),
      } as unknown as ConnectorCloudClient,
    });

    const bindings = await runtime.resolveBindingsForTurn();

    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      kind: 'app',
      source: 'notion',
      toolMode: 'tool_search',
      tool: { def: { name: 'notion_search' } },
    });
  });

  it('normalizes INLINE, missing, null, zero, and unknown agent modes to inline', async () => {
    const runtime = new DesktopConnectorRuntime({
      client: {
        listConnectedTools: vi.fn(async () => ({
          tools: [
            {
              provider: 'drive',
              providerToolName: 'inline',
              runtimeToolName: 'drive_inline',
              inputSchemaJson: '{}',
              agentToolMode: AgentToolMode.INLINE,
            },
            {
              provider: 'drive',
              providerToolName: 'missing',
              runtimeToolName: 'drive_missing',
              inputSchemaJson: '{}',
            },
            {
              provider: 'drive',
              providerToolName: 'null',
              runtimeToolName: 'drive_null',
              inputSchemaJson: '{}',
              agentToolMode: null as never,
            },
            {
              provider: 'drive',
              providerToolName: 'zero',
              runtimeToolName: 'drive_zero',
              inputSchemaJson: '{}',
              agentToolMode: 0 as AgentToolMode,
            },
            {
              provider: 'drive',
              providerToolName: 'future',
              runtimeToolName: 'drive_future',
              inputSchemaJson: '{}',
              agentToolMode: 99 as AgentToolMode,
            },
          ],
          providerFailures: [],
          partial: false,
        })),
        callTool: vi.fn(),
      } as unknown as ConnectorCloudClient,
    });

    const bindings = await runtime.resolveBindingsForTurn();

    expect(bindings.map((binding) => binding.toolMode)).toEqual([
      'inline',
      'inline',
      'inline',
      'inline',
      'inline',
    ]);
  });
});

describe('DesktopConnectorRuntime tool behavior', () => {
  it('resolves independently for every turn and keeps successful tools from partial results', async () => {
    const listConnectedTools = vi.fn(async () => ({
      tools: [
        {
          provider: 'drive',
          providerDisplayName: 'Google Drive',
          providerLogoUrl: 'https://example.com/drive.png',
          providerToolName: 'search',
          runtimeToolName: 'drive_search',
          description: 'Search Drive',
          inputSchemaJson: '{"type":"object","properties":{"query":{"type":"string"}}}',
        },
        {
          provider: 'duplicate',
          providerToolName: 'search',
          runtimeToolName: ' DRIVE_SEARCH ',
          inputSchemaJson: '{broken',
        },
      ],
      providerFailures: [
        { provider: 'mail', code: 'UNAVAILABLE', message: 'secret', retryable: true },
      ],
      partial: true,
    }));
    const callTool = vi.fn(async () => ({
      resultJson: '{"items":[]}',
      isError: false,
      latencyMs: 8,
    }));
    const logger = { warn: vi.fn() };
    const metrics = { incr: vi.fn(), latency: vi.fn() };
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools, callTool } as unknown as ConnectorCloudClient,
      logger,
      metrics,
    });

    const first = await runtime.resolveForTurn();
    const second = await runtime.resolveForTurn();
    expect(listConnectedTools).toHaveBeenCalledTimes(2);
    expect(first.map((tool) => tool.def.name)).toEqual(['drive_search']);
    expect(second.map((tool) => tool.def.name)).toEqual(['drive_search']);
    expect(logger.warn).toHaveBeenCalledWith('Desktop Connector provider resolve failed', {
      provider: 'mail',
      code: 'UNAVAILABLE',
      retryable: true,
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');

    const signal = new AbortController().signal;
    await expect(
      first[0]!.impl.execute(
        { sessionId: 'session-1', turnId: 'turn-1', toolCallId: 'call-1' },
        { query: 'roadmap' },
        signal,
      ),
    ).resolves.toEqual({
      tool_name: 'drive_search',
      text: '{"items":[]}',
      content: [{ type: 'text', text: '{"items":[]}' }],
      details: {
        is_error: false,
        error_code: undefined,
        error_message: undefined,
        latency_ms: 8,
        provider_usage_json: undefined,
        app: {
          provider: 'drive',
          display_name: 'Google Drive',
          icon_url: 'https://example.com/drive.png',
          tool: 'search',
        },
      },
    });
    expect(callTool).toHaveBeenCalledWith({
      provider: 'drive',
      providerToolName: 'search',
      runtimeToolName: 'drive_search',
      arguments: { query: 'roadmap' },
      sessionId: 'session-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      requestId: 'call-1',
      signal,
    });
    expect(metrics.latency).toHaveBeenCalledWith('desktop_connector_call_latency_ms', 8, {
      status: 'ok',
    });
  });

  it('fails open to an empty per-turn inventory when the list request fails', async () => {
    const logger = { warn: vi.fn() };
    const runtime = new DesktopConnectorRuntime({
      client: {
        listConnectedTools: vi.fn(async () => {
          throw new Error('private network detail');
        }),
      } as unknown as ConnectorCloudClient,
      logger,
    });

    await expect(runtime.resolveForTurn()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith('Desktop Connector tools resolve failed', {
      errorType: 'Error',
    });
  });

  it('treats a logged-out Desktop as an expected empty inventory without warning', async () => {
    const logger = { warn: vi.fn() };
    const metrics = { incr: vi.fn(), latency: vi.fn() };
    const runtime = new DesktopConnectorRuntime({
      client: {
        listConnectedTools: vi.fn(async () => {
          throw Object.assign(new Error('login required'), { code: 'AUTH_REQUIRED' });
        }),
      } as unknown as ConnectorCloudClient,
      logger,
      metrics,
    });

    await expect(runtime.resolveForTurn()).resolves.toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(metrics.incr).toHaveBeenCalledWith('desktop_connector_resolve_total', {
      status: 'unauthenticated',
    });
  });

  it('maps provider errors without converting them into transport failures', async () => {
    const runtime = new DesktopConnectorRuntime({
      client: {
        listConnectedTools: vi.fn(async () => ({
          tools: [
            {
              provider: 'mail',
              providerToolName: 'send',
              runtimeToolName: 'mail_send',
              inputSchemaJson: '{broken',
            },
          ],
          providerFailures: [],
          partial: false,
        })),
        callTool: vi.fn(async () => ({
          isError: true,
          errorCode: 'DENIED',
          errorMessage: 'Permission denied',
        })),
      } as unknown as ConnectorCloudClient,
    });
    const [tool] = await runtime.resolveForTurn();
    expect(tool?.def.schema).toEqual({ type: 'object', properties: {} });

    await expect(
      tool!.impl.execute({ sessionId: 's', turnId: 't' }, {}, undefined),
    ).resolves.toMatchObject({
      tool_name: 'mail_send',
      text: 'Permission denied',
      isError: true,
      details: { error_code: 'DENIED' },
    });
  });

  it('propagates a tool-call transport failure and records it separately', async () => {
    const metrics = { incr: vi.fn(), latency: vi.fn() };
    const runtime = new DesktopConnectorRuntime({
      client: {
        listConnectedTools: vi.fn(async () => ({
          tools: [
            {
              provider: 'drive',
              providerToolName: 'search',
              runtimeToolName: 'drive_search',
              inputSchemaJson: '{}',
            },
          ],
          providerFailures: [],
          partial: false,
        })),
        callTool: vi.fn(async () => {
          throw new Error('network unavailable');
        }),
      } as unknown as ConnectorCloudClient,
      metrics,
    });
    const [tool] = await runtime.resolveForTurn();

    await expect(tool!.impl.execute({ sessionId: 's', turnId: 't' }, {})).rejects.toThrow(
      'network unavailable',
    );
    expect(metrics.incr).toHaveBeenCalledWith('desktop_connector_call_total', {
      status: 'error',
    });
  });
});

describe('DesktopConnectorRuntime resolve circuit breaker', () => {
  it('backs off retryable Cloud failures without caching a successful inventory', async () => {
    let nowMs = 1_000;
    const listConnectedTools = vi
      .fn<ConnectorCloudClient['listConnectedTools']>()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' }))
      .mockRejectedValueOnce(
        Object.assign(new Error('unavailable'), { code: 'HTTP_ERROR', status: 503 }),
      )
      .mockResolvedValueOnce({
        tools: [
          {
            provider: 'drive',
            providerToolName: 'search',
            runtimeToolName: 'drive_search',
            inputSchemaJson: '{}',
          },
        ],
        providerFailures: [],
        partial: false,
      })
      .mockResolvedValueOnce({ tools: [], providerFailures: [], partial: false });
    const metrics = { incr: vi.fn(), latency: vi.fn() };
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools } as unknown as ConnectorCloudClient,
      metrics,
      nowMs: () => nowMs,
      scopeKeyGetter: () => 'alice\0cn-test',
    });

    await expect(runtime.resolveBindingsForTurn()).resolves.toEqual([]);
    nowMs += 9_999;
    await expect(runtime.resolveBindingsForTurn()).resolves.toEqual([]);
    expect(listConnectedTools).toHaveBeenCalledOnce();

    nowMs += 1;
    await expect(runtime.resolveBindingsForTurn()).resolves.toEqual([]);
    nowMs += 19_999;
    await expect(runtime.resolveBindingsForTurn()).resolves.toEqual([]);
    expect(listConnectedTools).toHaveBeenCalledTimes(2);

    nowMs += 1;
    await expect(runtime.resolveBindingsForTurn()).resolves.toHaveLength(1);
    await expect(runtime.resolveBindingsForTurn()).resolves.toEqual([]);
    expect(listConnectedTools).toHaveBeenCalledTimes(4);
    expect(metrics.incr).toHaveBeenCalledWith('desktop_connector_resolve_total', {
      status: 'circuit_open',
    });
  });

  it('caps repeated retryable Connector failures at a thirty-second cooldown', async () => {
    let nowMs = 1_000;
    const listConnectedTools = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' });
    });
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools } as unknown as ConnectorCloudClient,
      nowMs: () => nowMs,
      scopeKeyGetter: () => 'alice\0cn-test',
    });

    for (const cooldownMs of [10_000, 20_000, 30_000, 30_000]) {
      await runtime.resolveBindingsForTurn();
      const calls = listConnectedTools.mock.calls.length;
      nowMs += cooldownMs - 1;
      await runtime.resolveBindingsForTurn();
      expect(listConnectedTools).toHaveBeenCalledTimes(calls);
      nowMs += 1;
    }
    expect(listConnectedTools).toHaveBeenCalledTimes(4);
  });

  it('retries immediately after scope or auth context changes', async () => {
    let scopeKey = 'alice\0cn-test';
    const listConnectedTools = vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' });
    });
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools } as unknown as ConnectorCloudClient,
      nowMs: () => 1_000,
      scopeKeyGetter: () => scopeKey,
    });

    await runtime.resolveBindingsForTurn();
    await runtime.resolveBindingsForTurn();
    expect(listConnectedTools).toHaveBeenCalledOnce();

    scopeKey = 'bob\0cn-test';
    await runtime.resolveBindingsForTurn();
    expect(listConnectedTools).toHaveBeenCalledTimes(2);

    await runtime.resolveBindingsForTurn();
    runtime.authContextChanged();
    await runtime.resolveBindingsForTurn();
    expect(listConnectedTools).toHaveBeenCalledTimes(3);
  });

  it('does not let an old in-flight auth failure reopen the cleared circuit', async () => {
    let rejectOld!: (error: unknown) => void;
    const oldRequest = new Promise<never>((_resolve, reject) => {
      rejectOld = reject;
    });
    const listConnectedTools = vi
      .fn<ConnectorCloudClient['listConnectedTools']>()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce({ tools: [], providerFailures: [], partial: false });
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools } as unknown as ConnectorCloudClient,
      nowMs: () => 1_000,
      scopeKeyGetter: () => 'alice\0cn-test',
    });

    const stale = runtime.resolveBindingsForTurn();
    runtime.authContextChanged();
    rejectOld(Object.assign(new Error('old token failed'), { code: 'NETWORK_ERROR' }));
    await expect(stale).resolves.toEqual([]);
    await expect(runtime.resolveBindingsForTurn()).resolves.toEqual([]);

    expect(listConnectedTools).toHaveBeenCalledTimes(2);
  });

  it('does not let older same-scope requests overwrite a newer breaker decision', async () => {
    let resolveOldSuccess!: (value: ConnectedConnectorToolsResult) => void;
    let rejectOldFailure!: (error: unknown) => void;
    const oldSuccess = new Promise<ConnectedConnectorToolsResult>((resolve) => {
      resolveOldSuccess = resolve;
    });
    const oldFailure = new Promise<ConnectedConnectorToolsResult>((_resolve, reject) => {
      rejectOldFailure = reject;
    });
    const empty = { tools: [], providerFailures: [], partial: false };

    const successWins = vi
      .fn<ConnectorCloudClient['listConnectedTools']>()
      .mockReturnValueOnce(oldFailure)
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce(empty);
    const firstRuntime = new DesktopConnectorRuntime({
      client: { listConnectedTools: successWins } as unknown as ConnectorCloudClient,
      nowMs: () => 1_000,
      scopeKeyGetter: () => 'alice\0cn-test',
    });
    const staleFailure = firstRuntime.resolveBindingsForTurn();
    await firstRuntime.resolveBindingsForTurn();
    rejectOldFailure(Object.assign(new Error('late offline'), { code: 'NETWORK_ERROR' }));
    await staleFailure;
    await firstRuntime.resolveBindingsForTurn();
    expect(successWins).toHaveBeenCalledTimes(3);

    const failureWins = vi
      .fn<ConnectorCloudClient['listConnectedTools']>()
      .mockReturnValueOnce(oldSuccess)
      .mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }));
    const secondRuntime = new DesktopConnectorRuntime({
      client: { listConnectedTools: failureWins } as unknown as ConnectorCloudClient,
      nowMs: () => 1_000,
      scopeKeyGetter: () => 'alice\0cn-test',
    });
    const staleSuccess = secondRuntime.resolveBindingsForTurn();
    await secondRuntime.resolveBindingsForTurn();
    resolveOldSuccess(empty);
    await staleSuccess;
    await secondRuntime.resolveBindingsForTurn();
    expect(failureWins).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['AUTH_REQUIRED', undefined],
    ['REQUEST_ABORTED', undefined],
    ['HTTP_ERROR', 400],
    ['BUSINESS_ERROR', undefined],
  ])('does not open the circuit for %s failures', async (code, status) => {
    const listConnectedTools = vi.fn(async () => {
      throw Object.assign(new Error('non-retryable'), { code, ...(status ? { status } : {}) });
    });
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools } as unknown as ConnectorCloudClient,
      nowMs: () => 1_000,
      scopeKeyGetter: () => 'alice\0cn-test',
    });

    await runtime.resolveBindingsForTurn();
    await runtime.resolveBindingsForTurn();

    expect(listConnectedTools).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['HTTP_ERROR', 429],
    ['HTTP_ERROR', 500],
    ['HTTP_ERROR', 503],
  ])('opens the circuit for %s status %s', async (code, status) => {
    const listConnectedTools = vi.fn(async () => {
      throw Object.assign(new Error('retryable'), { code, status });
    });
    const runtime = new DesktopConnectorRuntime({
      client: { listConnectedTools } as unknown as ConnectorCloudClient,
      nowMs: () => 1_000,
      scopeKeyGetter: () => 'alice\0cn-test',
    });

    await runtime.resolveBindingsForTurn();
    await runtime.resolveBindingsForTurn();

    expect(listConnectedTools).toHaveBeenCalledOnce();
  });
});
