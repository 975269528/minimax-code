import { type LocalWebSearchAdapter, type WebSearchInput } from '@mavis/agent-tools/desktop';
import {
  callMatrixTool,
  MATRIX_TOOL_PATHS,
  MATRIX_TOOL_TIMEOUTS,
  type MatrixToolContext,
} from '@mavis/agent-tools/matrix';
import type { ToolResult } from '@mavis/agent-core/tools';

import { LocalMatrixClient, type LocalMatrixClientOptions } from '../matrix/local-matrix-client.js';

export const LOCAL_WEB_SEARCH_TIMEOUT_MS = MATRIX_TOOL_TIMEOUTS.web_search;

export type LocalWebSearchClientOptions = LocalMatrixClientOptions;

export class LocalWebSearchClient implements LocalWebSearchAdapter {
  private readonly client: LocalMatrixClient;

  constructor(options: LocalWebSearchClientOptions = {}) {
    this.client = new LocalMatrixClient(options);
  }

  search(ctx: MatrixToolContext, input: WebSearchInput, signal?: AbortSignal): Promise<ToolResult> {
    return callMatrixTool({
      toolName: 'web_search',
      path: MATRIX_TOOL_PATHS.web_search,
      input,
      ctx,
      archonServer: this.client,
      ...(signal ? { signal } : {}),
    });
  }
}

export function createManagedLocalWebSearchClient(
  options: Pick<
    LocalWebSearchClientOptions,
    'authContext' | 'fetchImpl' | 'routingContextGetter'
  > = {},
): LocalWebSearchClient {
  return new LocalWebSearchClient({
    ...(options.authContext ? { authContext: options.authContext } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    routingContextGetter: options.routingContextGetter,
  });
}
