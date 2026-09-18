import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  AUTH_LEASE_AUDIENCE,
  AUTH_LEASE_PROTOCOL_VERSION,
  AUTH_LEASE_SCOPES,
  AuthLeaseProtocolError,
  resolveAuthLeaseEndpoint,
  startNodeAuthLeaseServer,
  type AuthLeaseRequest,
  type AuthLeaseSuccessResult,
  type NodeAuthLeaseServer,
} from '@mavis/oauth-lease-protocol';

import type {
  McodeToolsAccessTokenLease,
  McodeToolsAuthStatusSnapshot,
  McodeToolsHostAuthSession,
  McodeToolsHostLogger,
} from './contracts.js';

const NOOP_LOGGER: McodeToolsHostLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface McodeToolsAuthLeaseBroker {
  endpoint: string;
  capabilityFile: string;
  dispose(): Promise<void>;
}

export interface StartMcodeToolsAuthLeaseBrokerOptions {
  dataDir: string;
  session: McodeToolsHostAuthSession;
  now?: () => number;
  logger?: McodeToolsHostLogger;
}

export async function startMcodeToolsAuthLeaseBroker(
  options: StartMcodeToolsAuthLeaseBrokerOptions,
): Promise<McodeToolsAuthLeaseBroker> {
  const endpoint = resolveAuthLeaseEndpoint(options.dataDir);
  const capability = randomBytes(32).toString('base64url');
  const now = options.now ?? Date.now;
  const brokerLogger = options.logger ?? NOOP_LOGGER;
  let cachedLease: McodeToolsAccessTokenLease | undefined;
  let inFlight:
    | {
        epoch: number;
        promise: Promise<McodeToolsAccessTokenLease>;
      }
    | undefined;
  let epoch = 0;
  let minimumGeneration = 0;
  let admissionOpen = true;
  let disposed = false;
  let server: NodeAuthLeaseServer | undefined;
  let stopWatching: (() => void) | undefined;

  function invalidate(): void {
    epoch += 1;
    cachedLease = undefined;
  }

  async function loadValidatedLease(
    minValidityMs: number,
    requestEpoch: number,
  ): Promise<McodeToolsAccessTokenLease> {
    const lease = await loadLease(options.session, minValidityMs);
    assertFixedLease(lease);
    if (disposed) throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    if (requestEpoch !== epoch || !admissionOpen || lease.generation < minimumGeneration) {
      throw new AuthLeaseProtocolError('AUTH_REQUIRED');
    }
    cachedLease = lease;
    return lease;
  }

  async function acquireLease(minValidityMs: number): Promise<McodeToolsAccessTokenLease> {
    if (disposed) throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    if (!admissionOpen) throw new AuthLeaseProtocolError('AUTH_REQUIRED');
    if (
      cachedLease &&
      admissionOpen &&
      cachedLease.generation >= minimumGeneration &&
      isUsableLease(cachedLease, minValidityMs, now())
    ) {
      return cachedLease;
    }

    for (;;) {
      if (inFlight) {
        const lease = await inFlight.promise;
        if (
          admissionOpen &&
          lease.generation >= minimumGeneration &&
          isUsableLease(lease, minValidityMs, now())
        ) {
          return lease;
        }
        continue;
      }

      const requestEpoch = epoch;
      const request = loadValidatedLease(minValidityMs, requestEpoch);
      const current = { epoch: requestEpoch, promise: request };
      inFlight = current;
      try {
        const lease = await request;
        if (
          admissionOpen &&
          lease.generation >= minimumGeneration &&
          isUsableLease(lease, minValidityMs, now())
        ) {
          return lease;
        }
      } finally {
        if (inFlight === current) inFlight = undefined;
      }
    }
  }

  async function handleRequest(request: AuthLeaseRequest): Promise<AuthLeaseSuccessResult> {
    if (disposed) throw new AuthLeaseProtocolError('BROKER_UNAVAILABLE');
    if (request.method === 'status') return await getCredentialFreeStatus(options.session);
    if (request.method === 'lease') {
      const lease = await acquireLease(request.minValidityMs);
      return {
        method: 'lease',
        accessToken: lease.accessToken,
        expiresAtMs: lease.expiresAtMs,
        generation: lease.generation,
        audience: AUTH_LEASE_AUDIENCE,
        scopes: AUTH_LEASE_SCOPES,
      };
    }
    invalidate();
    const action = await options.session.handleUnauthorized(request.generation);
    return { method: 'unauthorized', action };
  }

  await atomicWriteCapability(endpoint.capabilityFile, capability);
  try {
    server = await startNodeAuthLeaseServer({
      endpoint: endpoint.endpoint,
      capability,
      handler: handleRequest,
    });
    stopWatching = options.session.watch((status) => {
      minimumGeneration = Math.max(minimumGeneration, status.generation);
      const generationChanged =
        cachedLease !== undefined && cachedLease.generation < minimumGeneration;
      const admissionClosed = status.status !== 'authenticated' && status.status !== 'refreshing';
      admissionOpen = !admissionClosed;
      if (admissionClosed) invalidate();
      else if (generationChanged) cachedLease = undefined;
    });
  } catch (error) {
    await server?.close().catch(() => undefined);
    await rm(endpoint.capabilityFile, { force: true });
    throw error;
  }

  brokerLogger.info(`[auth-lease-broker] ready protocol=${AUTH_LEASE_PROTOCOL_VERSION}`);

  return {
    endpoint: endpoint.endpoint,
    capabilityFile: endpoint.capabilityFile,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      invalidate();
      stopWatching?.();
      stopWatching = undefined;
      try {
        await server?.close();
      } catch {
        brokerLogger.warn('[auth-lease-broker] dispose transport_error');
      } finally {
        server = undefined;
        await rm(endpoint.capabilityFile, { force: true });
      }
      brokerLogger.info(`[auth-lease-broker] disposed protocol=${AUTH_LEASE_PROTOCOL_VERSION}`);
    },
  };
}

async function getCredentialFreeStatus(
  session: McodeToolsHostAuthSession,
): Promise<AuthLeaseSuccessResult> {
  const status = await session.getStatus();
  return {
    method: 'status',
    status: status.status,
    generation: status.generation,
    ...(status.expiresAtMs === undefined ? {} : { expiresAtMs: status.expiresAtMs }),
  };
}

async function loadLease(
  session: McodeToolsHostAuthSession,
  minValidityMs: number,
): Promise<McodeToolsAccessTokenLease> {
  try {
    return await session.getAccessToken(minValidityMs);
  } catch (error) {
    const status = await readStatusAfterLeaseFailure(session);
    if (!status || status.status !== 'authenticated') {
      throw new AuthLeaseProtocolError('AUTH_REQUIRED');
    }
    throw error;
  }
}

async function readStatusAfterLeaseFailure(
  session: McodeToolsHostAuthSession,
): Promise<McodeToolsAuthStatusSnapshot | undefined> {
  try {
    return await session.getStatus();
  } catch {
    return undefined;
  }
}

function isUsableLease(
  lease: McodeToolsAccessTokenLease,
  minValidityMs: number,
  nowMs: number,
): boolean {
  return lease.expiresAtMs - nowMs >= minValidityMs;
}

function assertFixedLease(lease: McodeToolsAccessTokenLease): void {
  if (
    lease.audience !== AUTH_LEASE_AUDIENCE ||
    lease.scopes.length !== 1 ||
    lease.scopes[0] !== AUTH_LEASE_SCOPES[0]
  ) {
    throw new AuthLeaseProtocolError('INTERNAL_ERROR');
  }
}

async function atomicWriteCapability(capabilityFile: string, capability: string): Promise<void> {
  const directory = path.dirname(capabilityFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const temporaryFile = `${capabilityFile}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporaryFile, 'wx', 0o600);
    await handle.writeFile(`${capability}\n`, 'utf8');
    await handle.sync();
    if (process.platform !== 'win32') await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, capabilityFile);
    if (process.platform !== 'win32') await chmod(capabilityFile, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true });
    throw error;
  }
}
