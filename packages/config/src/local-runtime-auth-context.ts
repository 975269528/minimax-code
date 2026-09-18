import fs from 'node:fs';
import path from 'node:path';
import { retryWindowsFileSystemOperation } from '@mavis/shared';

export const LOCAL_RUNTIME_AUTH_CONTEXT_FILE = 'local-runtime.auth.json';

export interface LocalRuntimeAuthContextSnapshot {
  accessToken?: string;
  realUserID?: string;
  userEmail?: string;
  userName?: string;
  subUserName?: string;
}

interface PersistedLocalRuntimeAuthContext {
  version: 1;
  updatedAtMs: number;
  auth: LocalRuntimeAuthContextSnapshot;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeLocalRuntimeAuthContext(
  data: Record<string, unknown> | LocalRuntimeAuthContextSnapshot | undefined,
): LocalRuntimeAuthContextSnapshot {
  if (!data) return {};
  return {
    ...(readOptionalString(data.accessToken)
      ? { accessToken: readOptionalString(data.accessToken) }
      : {}),
    ...(readOptionalString(data.realUserID)
      ? { realUserID: readOptionalString(data.realUserID) }
      : {}),
    ...(readOptionalString(data.userEmail)
      ? { userEmail: readOptionalString(data.userEmail) }
      : {}),
    ...(readOptionalString(data.userName) ? { userName: readOptionalString(data.userName) } : {}),
    ...(readOptionalString(data.subUserName)
      ? { subUserName: readOptionalString(data.subUserName) }
      : {}),
  };
}

export function resolveLocalRuntimeAuthContextPath(dataDir: string): string {
  return path.join(dataDir, LOCAL_RUNTIME_AUTH_CONTEXT_FILE);
}

export function readLocalRuntimeAuthContext(
  dataDir: string,
): LocalRuntimeAuthContextSnapshot | undefined {
  try {
    const raw = fs.readFileSync(resolveLocalRuntimeAuthContextPath(dataDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedLocalRuntimeAuthContext>;
    if (parsed.version !== 1 || !parsed.auth || typeof parsed.auth !== 'object') return undefined;
    const auth = normalizeLocalRuntimeAuthContext(parsed.auth);
    return auth.accessToken ? auth : undefined;
  } catch {
    return undefined;
  }
}

export function writeLocalRuntimeAuthContext(
  dataDir: string,
  data: Record<string, unknown> | LocalRuntimeAuthContextSnapshot,
  options: { retryWindowsFileSystem?: boolean } = {},
): { path: string; written: boolean } {
  const filePath = resolveLocalRuntimeAuthContextPath(dataDir);
  const auth = normalizeLocalRuntimeAuthContext(data);
  if (!auth.accessToken) {
    clearLocalRuntimeAuthContextFile(dataDir);
    return { path: filePath, written: false };
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const payload: PersistedLocalRuntimeAuthContext = {
    version: 1,
    updatedAtMs: Date.now(),
    auth,
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  if (options.retryWindowsFileSystem) {
    retryWindowsFileSystemOperation(() => fs.renameSync(tmpPath, filePath));
    retryWindowsFileSystemOperation(() => fs.chmodSync(filePath, 0o600));
  } else {
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, 0o600);
  }
  return { path: filePath, written: true };
}

export function clearLocalRuntimeAuthContextFile(dataDir: string): void {
  try {
    fs.rmSync(resolveLocalRuntimeAuthContextPath(dataDir), { force: true });
  } catch {
    // Best-effort cleanup. Callers should not fail logout/runtime shutdown just
    // because an auth context file was already gone or temporarily locked.
  }
}
