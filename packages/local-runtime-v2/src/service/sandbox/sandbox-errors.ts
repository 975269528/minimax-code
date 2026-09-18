const SANDBOX_ERROR_CODES = [
  'SANDBOX_UNSUPPORTED_PLATFORM',
  'SANDBOX_DEPENDENCY_MISSING',
  'SANDBOX_CONFIG_INVALID',
  'SANDBOX_INITIALIZATION_FAILED',
  'SANDBOX_WORKSPACE_INVALID',
  'SANDBOX_WRAP_FAILED',
  'SANDBOX_PERMISSION_UNAVAILABLE',
  'SANDBOX_RESTART_REQUIRED',
  'SANDBOX_CLOSING',
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_UNSUPPORTED_ON_LEGACY_HOST',
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export type SandboxErrorStage =
  | 'init'
  | 'parse'
  | 'invocation'
  | 'pre-spawn'
  | 'network-ask'
  | 'commit'
  | 'close'
  | 'http';

export class SandboxError extends Error {
  override readonly name = 'SandboxError';

  constructor(
    readonly code: SandboxErrorCode,
    readonly stage: SandboxErrorStage,
    message: string,
    readonly fieldPath?: string,
  ) {
    super(message);
  }
}

export function isSandboxError(error: unknown): error is SandboxError {
  return error instanceof SandboxError;
}
