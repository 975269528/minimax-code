import type { ToolExecutionContext } from '@mavis/agent-core/tools';

export type { MatrixPathScope } from './path-guard.js';

export interface MatrixToolLogger {
  info(ctx: MatrixToolContext, message: string): void;
  warn(ctx: MatrixToolContext, message: string): void;
  debug?(ctx: MatrixToolContext, message: string): void;
}

export interface MatrixToolContext extends ToolExecutionContext {
  readonly workspaceRoot?: string;
  readonly matrixLogger?: MatrixToolLogger;
}

export interface MatrixExecutor {
  postJson(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

export interface MatrixUploadOptions {
  readonly filename?: string;
  readonly mimeType?: string;
  readonly ttlSeconds?: number;
  readonly category?: string;
  readonly forceRemoteUrl?: boolean;
}

export interface MatrixUploadResult {
  readonly ossKey: string;
  readonly signedUrl?: string;
  readonly inlineData?: string;
  readonly mimeType?: string;
  readonly bytes: number;
}

export interface MatrixDownloadToFileOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface MatrixMediaClient {
  uploadFile(localPath: string, options?: MatrixUploadOptions): Promise<MatrixUploadResult>;
  downloadToFile(
    url: string,
    localPath: string,
    options?: MatrixDownloadToFileOptions,
  ): Promise<{ bytes: number }>;
}

export class MatrixMediaError extends Error {
  readonly underlying?: unknown;

  constructor(
    readonly kind:
      | 'file_not_found'
      | 'upload_failed'
      | 'download_failed'
      | 'write_failed'
      | 'file_too_large'
      | 'aborted',
    message: string,
    underlying?: unknown,
  ) {
    super(message);
    this.name = 'MatrixMediaError';
    if (underlying !== undefined) this.underlying = underlying;
  }
}

export function readMatrixMediaErrorKind(err: unknown): string | undefined {
  if (err instanceof MatrixMediaError) return err.kind;
  if (err && typeof err === 'object') {
    const kind = (err as { kind?: unknown }).kind;
    return typeof kind === 'string' ? kind : undefined;
  }
  return undefined;
}
