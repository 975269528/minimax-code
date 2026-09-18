import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';
import type { TSchema } from '@sinclair/typebox';
import {
  buildMatrixTools,
  type MatrixMediaClient,
  type MatrixToolContext,
  type MatrixToolLogger,
} from '../cloud/matrix-tools/index.js';
import {
  DesktopMatrixClient,
  type DesktopMatrixAuthContext,
  type DesktopMatrixClientOptions,
  type DesktopMatrixExecutor,
} from './matrix-client.js';
import { DesktopMatrixMediaClient } from './matrix-media-client.js';

export interface BuildDesktopMatrixToolsOptions {
  workspaceRoot: string;
  /** Extra *input*-only fence roots (e.g. local-runtime dataDir assets). */
  extraInputRoots?: readonly string[];
  authContext?: DesktopMatrixAuthContext;
  baseUrl?: string;
  accessToken?: string;
  fetchImpl?: DesktopMatrixClientOptions['fetchImpl'];
  executor?: DesktopMatrixExecutor;
  mediaClient?: MatrixMediaClient;
  matrixLogger?: MatrixToolLogger;
}

export function buildDesktopMatrixRuntimeTools(
  options: BuildDesktopMatrixToolsOptions,
): Array<RuntimeTool<TSchema, ToolExecutionContext>> {
  const executor =
    options.executor ??
    new DesktopMatrixClient({
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
      ...(options.authContext ? { authContext: options.authContext } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  const mediaClient =
    options.mediaClient ??
    new DesktopMatrixMediaClient(
      executor instanceof DesktopMatrixClient
        ? executor
        : new DesktopMatrixClient({
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            ...(options.accessToken ? { accessToken: options.accessToken } : {}),
            ...(options.authContext ? { authContext: options.authContext } : {}),
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          }),
    );
  const workspaceScope = options.extraInputRoots?.length
    ? { workspaceRoot: options.workspaceRoot, extraInputRoots: options.extraInputRoots }
    : options.workspaceRoot;
  return buildMatrixTools(executor, mediaClient, workspaceScope, null, {
    ...(options.matrixLogger ? { matrixLogger: options.matrixLogger } : {}),
  }) as Array<RuntimeTool<TSchema, MatrixToolContext>>;
}
