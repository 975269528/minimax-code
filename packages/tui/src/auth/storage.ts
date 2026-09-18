import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { retryWindowsFileSystemOperation } from '@mavis/shared';

import {
  clearLocalRuntimeAuthContextFile,
  normalizeLocalRuntimeAuthContext,
  readLocalRuntimeAuthContext,
  writeLocalRuntimeAuthContext,
  type LocalRuntimeAuthContextSnapshot,
  type MavisBuildEnv,
} from '@mavis/config';
import type { CliAuthScope } from './types.js';
import {
  clearCliAccountIdentity,
  isCliAccessTokenRejected,
  readVerifiedCliAccountIdentity,
} from './identity-storage.js';

const CLI_AUTH_CONTEXT_DIRECTORY = 'cli-auth';
const CLI_AUTH_SCOPE_FILE = 'cli-auth.scope.json';
const CLI_SHARED_PROJECTION_FILE = 'shared-projection.json';

export type { CliAuthScope } from './types.js';

export interface CliAuthContextProjection {
  readonly auth: LocalRuntimeAuthContextSnapshot;
  readonly scope: CliAuthScope;
}

export interface WriteCliAuthContextOptions {
  readonly expectedSharedAuth?: LocalRuntimeAuthContextSnapshot;
}

interface CliAuthScopeRecord extends CliAuthScope {
  readonly version: 1;
  readonly updatedAtMs: number;
}

interface CliSharedProjectionRecord extends CliAuthScope {
  readonly version: 1;
  readonly authFingerprint: string;
  readonly updatedAtMs: number;
}

export function resolveCliAuthContextDataDir(dataDir: string, scope: CliAuthScope): string {
  return path.join(dataDir, CLI_AUTH_CONTEXT_DIRECTORY, scope.buildEnv, scope.region);
}

function resolveLegacyCliAuthContextDataDir(dataDir: string, buildEnv: MavisBuildEnv): string {
  return path.join(dataDir, CLI_AUTH_CONTEXT_DIRECTORY, buildEnv);
}

export function readCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
): LocalRuntimeAuthContextSnapshot | undefined {
  const privateAuth = readPrivateCliAuthContext(dataDir, scope);
  if (!privateAuth) return importSharedCliAuthContext(dataDir, scope);

  const sharedAuth = readLocalRuntimeAuthContext(dataDir);
  if (
    !sharedAuth ||
    authContextsEqual(privateAuth, sharedAuth) ||
    isCliOwnedSharedProjection(dataDir, sharedAuth)
  ) {
    return privateAuth;
  }
  return importSharedCliAuthContext(dataDir, scope);
}

export function readPrivateCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
): LocalRuntimeAuthContextSnapshot | undefined {
  const auth =
    readScopedPrivateCliAuthContext(dataDir, scope) ?? migrateLegacyCliAuthContext(dataDir, scope);
  return projectVerifiedAuthContext(dataDir, scope, auth);
}

export function readCliAuthContextProjection(
  dataDir: string,
  buildEnv: MavisBuildEnv,
): CliAuthContextProjection | undefined {
  const activeProjection =
    readCliOwnedSharedProjection(dataDir) ?? readLegacyCliAuthProjection(dataDir, buildEnv);
  if (!activeProjection || activeProjection.buildEnv !== buildEnv) return undefined;
  const scope = { region: activeProjection.region, buildEnv: activeProjection.buildEnv };
  const auth = readCliAuthContext(dataDir, scope);
  return auth?.accessToken ? { auth, scope } : undefined;
}

function readLegacyCliAuthProjection(
  dataDir: string,
  buildEnv: MavisBuildEnv,
): CliAuthScopeRecord | undefined {
  const legacyDirectory = resolveLegacyCliAuthContextDataDir(dataDir, buildEnv);
  const scope = readCliAuthScopeRecord(path.join(legacyDirectory, CLI_AUTH_SCOPE_FILE));
  return scope?.buildEnv === buildEnv ? scope : undefined;
}

export function writeCliAuthContext(
  dataDir: string,
  auth: Record<string, unknown> | LocalRuntimeAuthContextSnapshot,
  scope: CliAuthScope,
  options: WriteCliAuthContextOptions = {},
): { path: string; written: boolean } {
  const projection = normalizeLocalRuntimeAuthContext(auth);
  const result = writePrivateCliAuthContext(dataDir, projection, scope);
  const currentSharedAuth = readLocalRuntimeAuthContext(dataDir);
  if (
    options.expectedSharedAuth &&
    currentSharedAuth &&
    !authContextsEqual(currentSharedAuth, options.expectedSharedAuth) &&
    !isCliOwnedSharedProjection(dataDir, currentSharedAuth)
  ) {
    return result;
  }
  const runtimeProjection = writeLocalRuntimeAuthContext(dataDir, projection, {
    retryWindowsFileSystem: true,
  });
  if (runtimeProjection.written) writeCliSharedProjection(dataDir, scope, projection);
  else clearCliSharedProjection(dataDir);
  return result;
}

export function clearCliAuthContext(dataDir: string, scope: CliAuthScope): void {
  const auth =
    readRawPrivateCliAuthContext(dataDir, scope) ??
    readRejectedSharedCliAuthContext(dataDir, scope);
  invalidateCliAuthContext(dataDir, scope);
  clearCliAccountIdentity(dataDir, scope);
  if (auth) clearCliRuntimeAuthProjectionIfMatching(dataDir, auth);
}

export function readRejectedSharedCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
): LocalRuntimeAuthContextSnapshot | undefined {
  const auth = readLocalRuntimeAuthContext(dataDir);
  const accessToken = auth?.accessToken?.trim();
  return accessToken && isCliAccessTokenRejected(dataDir, scope, accessToken) ? auth : undefined;
}

function readRawPrivateCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
): LocalRuntimeAuthContextSnapshot | undefined {
  return (
    readScopedPrivateCliAuthContext(dataDir, scope) ?? migrateLegacyCliAuthContext(dataDir, scope)
  );
}

export function invalidateCliAuthContext(dataDir: string, scope: CliAuthScope): void {
  clearLocalRuntimeAuthContextFile(resolveCliAuthContextDataDir(dataDir, scope));
  clearCliAuthScope(dataDir, scope);
}

export function importSharedCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
  rejectedAccessToken?: string,
): LocalRuntimeAuthContextSnapshot | undefined {
  const auth = readLocalRuntimeAuthContext(dataDir);
  const accessToken = auth?.accessToken?.trim();
  const activeProjection = auth ? readCliOwnedSharedProjection(dataDir, auth) : undefined;
  if (
    !auth ||
    !accessToken ||
    (activeProjection && !isSameScope(activeProjection, scope)) ||
    accessToken === rejectedAccessToken?.trim() ||
    isCliAccessTokenRejected(dataDir, scope, accessToken)
  ) {
    return undefined;
  }
  const projection = normalizeLocalRuntimeAuthContext(auth);
  writePrivateCliAuthContext(dataDir, projection, scope);
  writeCliSharedProjection(dataDir, scope, projection);
  return projectVerifiedAuthContext(dataDir, scope, projection);
}

export function clearCliRuntimeAuthProjectionIfMatching(
  dataDir: string,
  auth: LocalRuntimeAuthContextSnapshot,
): boolean {
  const accessToken = auth.accessToken?.trim();
  const projectedAccessToken = readLocalRuntimeAuthContext(dataDir)?.accessToken?.trim();
  if (!accessToken || projectedAccessToken !== accessToken) return false;
  clearLocalRuntimeAuthContextFile(dataDir);
  clearCliSharedProjection(dataDir);
  return true;
}

export function syncCliRuntimeAuthProjection(
  dataDir: string,
  auth: LocalRuntimeAuthContextSnapshot,
): { path: string; written: boolean } {
  return writeLocalRuntimeAuthContext(dataDir, normalizeLocalRuntimeAuthContext(auth), {
    retryWindowsFileSystem: true,
  });
}

function projectVerifiedAuthContext(
  dataDir: string,
  scope: CliAuthScope,
  auth: LocalRuntimeAuthContextSnapshot | undefined,
): LocalRuntimeAuthContextSnapshot | undefined {
  const accessToken = auth?.accessToken?.trim();
  if (!accessToken || isCliAccessTokenRejected(dataDir, scope, accessToken)) return undefined;
  const identity = readVerifiedCliAccountIdentity(dataDir, scope, accessToken);
  if (!identity) return normalizeLocalRuntimeAuthContext(auth);
  const { verifiedAtMs, ...verifiedIdentity } = identity;
  void verifiedAtMs;
  return { ...verifiedIdentity, ...normalizeLocalRuntimeAuthContext(auth), accessToken };
}

function authContextsEqual(
  left: LocalRuntimeAuthContextSnapshot,
  right: LocalRuntimeAuthContextSnapshot,
): boolean {
  return authContextFingerprint(left) === authContextFingerprint(right);
}

function authContextFingerprint(auth: LocalRuntimeAuthContextSnapshot): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(normalizeLocalRuntimeAuthContext(auth)))
    .digest('hex')}`;
}

function resolveCliSharedProjectionPath(dataDir: string): string {
  return path.join(dataDir, CLI_AUTH_CONTEXT_DIRECTORY, CLI_SHARED_PROJECTION_FILE);
}

function isCliOwnedSharedProjection(
  dataDir: string,
  auth: LocalRuntimeAuthContextSnapshot,
): boolean {
  return Boolean(readCliOwnedSharedProjection(dataDir, auth));
}

function readCliOwnedSharedProjection(
  dataDir: string,
  auth: LocalRuntimeAuthContextSnapshot | undefined = readLocalRuntimeAuthContext(dataDir),
): CliSharedProjectionRecord | undefined {
  if (!auth) return undefined;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(resolveCliSharedProjectionPath(dataDir), 'utf8'),
    ) as Partial<CliSharedProjectionRecord>;
    return parsed.version === 1 &&
      (parsed.region === 'cn' || parsed.region === 'en') &&
      (parsed.buildEnv === 'dev' ||
        parsed.buildEnv === 'test' ||
        parsed.buildEnv === 'staging' ||
        parsed.buildEnv === 'prod') &&
      typeof parsed.authFingerprint === 'string' &&
      parsed.authFingerprint === authContextFingerprint(auth)
      ? (parsed as CliSharedProjectionRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeCliSharedProjection(
  dataDir: string,
  scope: CliAuthScope,
  auth: LocalRuntimeAuthContextSnapshot,
): void {
  const directory = path.join(dataDir, CLI_AUTH_CONTEXT_DIRECTORY);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = resolveCliSharedProjectionPath(dataDir);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const record: CliSharedProjectionRecord = {
    version: 1,
    ...scope,
    authFingerprint: authContextFingerprint(auth),
    updatedAtMs: Date.now(),
  };
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  retryWindowsFileSystemOperation(() => fs.renameSync(temporaryPath, filePath));
  retryWindowsFileSystemOperation(() => fs.chmodSync(filePath, 0o600));
}

function clearCliSharedProjection(dataDir: string): void {
  fs.rmSync(resolveCliSharedProjectionPath(dataDir), { force: true });
}

function writePrivateCliAuthContext(
  dataDir: string,
  auth: Record<string, unknown> | LocalRuntimeAuthContextSnapshot,
  scope: CliAuthScope,
): { path: string; written: boolean } {
  const result = writeLocalRuntimeAuthContext(resolveCliAuthContextDataDir(dataDir, scope), auth, {
    retryWindowsFileSystem: true,
  });
  if (result.written) writeCliAuthScope(dataDir, scope);
  else clearCliAuthScope(dataDir, scope);
  return result;
}

function readScopedPrivateCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
): LocalRuntimeAuthContextSnapshot | undefined {
  if (!isSameScope(readCliAuthScope(dataDir, scope), scope)) return undefined;
  return readLocalRuntimeAuthContext(resolveCliAuthContextDataDir(dataDir, scope));
}

function migrateLegacyCliAuthContext(
  dataDir: string,
  scope: CliAuthScope,
): LocalRuntimeAuthContextSnapshot | undefined {
  const legacyDirectory = resolveLegacyCliAuthContextDataDir(dataDir, scope.buildEnv);
  const legacyScope = readCliAuthScopeRecord(path.join(legacyDirectory, CLI_AUTH_SCOPE_FILE));
  if (!isSameScope(legacyScope, scope)) return undefined;
  const auth = readLocalRuntimeAuthContext(legacyDirectory);
  if (!auth?.accessToken) return undefined;
  writePrivateCliAuthContext(dataDir, auth, scope);
  clearLocalRuntimeAuthContextFile(legacyDirectory);
  fs.rmSync(path.join(legacyDirectory, CLI_AUTH_SCOPE_FILE), { force: true });
  return auth;
}

function resolveCliAuthScopePath(dataDir: string, scope: CliAuthScope): string {
  return path.join(resolveCliAuthContextDataDir(dataDir, scope), CLI_AUTH_SCOPE_FILE);
}

function readCliAuthScope(dataDir: string, scope: CliAuthScope): CliAuthScopeRecord | undefined {
  return readCliAuthScopeRecord(resolveCliAuthScopePath(dataDir, scope));
}

function readCliAuthScopeRecord(scopePath: string): CliAuthScopeRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(scopePath, 'utf8')) as Partial<CliAuthScopeRecord>;
    if (
      parsed.version !== 1 ||
      (parsed.region !== 'cn' && parsed.region !== 'en') ||
      (parsed.buildEnv !== 'dev' &&
        parsed.buildEnv !== 'test' &&
        parsed.buildEnv !== 'staging' &&
        parsed.buildEnv !== 'prod') ||
      typeof parsed.updatedAtMs !== 'number'
    ) {
      return undefined;
    }
    return parsed as CliAuthScopeRecord;
  } catch {
    return undefined;
  }
}

function writeCliAuthScope(dataDir: string, scope: CliAuthScope): void {
  const directory = resolveCliAuthContextDataDir(dataDir, scope);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const scopePath = resolveCliAuthScopePath(dataDir, scope);
  const temporaryPath = `${scopePath}.${process.pid}.${Date.now()}.tmp`;
  const record: CliAuthScopeRecord = { version: 1, updatedAtMs: Date.now(), ...scope };
  fs.writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  retryWindowsFileSystemOperation(() => fs.renameSync(temporaryPath, scopePath));
  retryWindowsFileSystemOperation(() => fs.chmodSync(scopePath, 0o600));
}

function clearCliAuthScope(dataDir: string, scope: CliAuthScope): void {
  fs.rmSync(resolveCliAuthScopePath(dataDir, scope), { force: true });
}

function isSameScope(left: CliAuthScope | undefined, right: CliAuthScope): boolean {
  return left?.region === right.region && left.buildEnv === right.buildEnv;
}
