import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MiniAppHostConnectorPolicy } from '../../contracts.js';
import { boundMiniAppRuntimeErrorText } from '../../errors.js';
import {
  createMiniAppHostConnectorRuntimeClient,
  type HostConnectorClient,
  type MiniAppHostConnectorRuntimeClient,
} from '../host-connector/host-connector.js';

const MAX_LOG_MESSAGE_LENGTH = 4 * 1024;
const runnerObservations = new Set<Promise<void>>();

export type MiniAppRunnerErrorCode =
  | 'ENTRY_OUTSIDE_ARTIFACT'
  | 'HOST_CONNECTOR_UNAVAILABLE'
  | 'RUNNER_LIFECYCLE_INVALID'
  | 'RUNNER_PROTOCOL_ERROR'
  | 'START_EXPORT_MISSING';

export type MiniAppRunnerFailureCode =
  | MiniAppRunnerErrorCode
  | 'EADDRINUSE'
  | 'RUNNER_START_FAILED';

const MINIAPP_RUNNER_ERROR_CODES: ReadonlySet<string> = new Set<MiniAppRunnerErrorCode>([
  'ENTRY_OUTSIDE_ARTIFACT',
  'HOST_CONNECTOR_UNAVAILABLE',
  'RUNNER_LIFECYCLE_INVALID',
  'RUNNER_PROTOCOL_ERROR',
  'START_EXPORT_MISSING',
]);

export interface MiniAppRunnerInitMessage {
  readonly type: 'miniapp:init';
  readonly protocolVersion: 1;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly packageRoot: string;
  readonly nodeEntry: string;
  readonly dataDir: string;
  readonly listen: { readonly host: '127.0.0.1'; readonly port: number };
  readonly readiness: { readonly startupToken: string; readonly nodeDigest: string };
  readonly hostConnectorPolicy: MiniAppHostConnectorPolicy;
}

export type MiniAppRunnerChildMessage =
  | {
      readonly type: 'miniapp:started';
      readonly pluginId: string;
      readonly processGeneration: string;
      readonly readiness: MiniAppRunnerInitMessage['readiness'];
    }
  | { readonly type: 'miniapp:stopped' }
  | { readonly type: 'miniapp:error'; readonly code: string; readonly errorText: string }
  | {
      readonly type: 'miniapp:log';
      readonly level: 'debug' | 'info' | 'warn' | 'error';
      readonly message: string;
      readonly fieldKeys: readonly string[];
    };

export class MiniAppRunnerError extends Error {
  override readonly name = 'MiniAppRunnerError';

  constructor(
    readonly code: MiniAppRunnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface RunningMiniAppModule {
  stop(): Promise<void>;
}

interface MiniAppStartContext {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly dataDir: string;
  readonly generationId: string;
  readonly listen: { readonly host: '127.0.0.1'; readonly port: number };
  readonly signal: AbortSignal;
  readonly logger: {
    debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
    error(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
  readonly hostConnector?: HostConnectorClient;
}

type StartResult = void | {
  readonly dispose: () => void | Promise<void>;
  readonly [key: string]: unknown;
};

/** Loads the package entry and gives it only the frozen, Host-owned runtime context. */
export async function startMiniAppModule(
  init: MiniAppRunnerInitMessage,
  options: {
    readonly emit?: (message: MiniAppRunnerChildMessage) => void;
    readonly resolveRealPath?: (target: string) => Promise<string>;
    readonly loadModule?: (url: string) => Promise<unknown>;
    readonly createHostConnector?: (input: {
      readonly pluginId: string;
      readonly processGeneration: string;
      readonly policy: MiniAppHostConnectorPolicy;
    }) => HostConnectorClient | undefined;
  } = {},
): Promise<RunningMiniAppModule> {
  const resolveRealPath = options.resolveRealPath ?? realpath;
  const packageRoot = await resolveRealPath(init.packageRoot);
  const start = await loadStartFunction(init, packageRoot, resolveRealPath, options.loadModule);
  assertConnectorAvailable(init, options.createHostConnector);
  const abortController = new AbortController();
  const logger = createLogger(options.emit);
  const hostConnector = options.createHostConnector?.({
    pluginId: init.pluginId,
    processGeneration: init.processGeneration,
    policy: init.hostConnectorPolicy,
  });
  const context = Object.freeze<MiniAppStartContext>({
    pluginId: init.pluginId,
    pluginRoot: packageRoot,
    dataDir: init.dataDir,
    generationId: init.processGeneration,
    listen: Object.freeze({ ...init.listen }),
    signal: abortController.signal,
    logger,
    ...(hostConnector ? { hostConnector } : {}),
  });
  let result: StartResult;
  try {
    result = await start(context);
  } catch (error) {
    abortController.abort();
    throw error;
  }
  const dispose = readDispose(result, abortController);
  let stopPromise: Promise<void> | undefined;
  return {
    stop() {
      stopPromise ??= (async () => {
        abortController.abort();
        await dispose?.();
      })();
      return stopPromise;
    },
  };
}

async function loadStartFunction(
  init: MiniAppRunnerInitMessage,
  packageRoot: string,
  resolveRealPath: (target: string) => Promise<string>,
  loadModule: ((url: string) => Promise<unknown>) | undefined,
): Promise<(context: MiniAppStartContext) => StartResult | Promise<StartResult>> {
  const entryPath = await resolveRealPath(path.resolve(packageRoot, init.nodeEntry));
  if (!isInside(packageRoot, entryPath)) {
    throw new MiniAppRunnerError(
      'ENTRY_OUTSIDE_ARTIFACT',
      'Mini App Node entry resolved outside its package artifact',
    );
  }
  const loaded = (await (loadModule ?? ((url) => import(url)))(pathToFileURL(entryPath).href)) as {
    readonly start?: unknown;
  };
  if (typeof loaded.start !== 'function') {
    throw new MiniAppRunnerError(
      'START_EXPORT_MISSING',
      'Mini App Node entry must export a named start function',
    );
  }
  return loaded.start as (context: MiniAppStartContext) => StartResult | Promise<StartResult>;
}

function assertConnectorAvailable(
  init: MiniAppRunnerInitMessage,
  create:
    | ((input: {
        readonly pluginId: string;
        readonly processGeneration: string;
        readonly policy: MiniAppHostConnectorPolicy;
      }) => HostConnectorClient | undefined)
    | undefined,
): void {
  if (init.hostConnectorPolicy.kind === 'allowlist' && !create) {
    throw new MiniAppRunnerError(
      'HOST_CONNECTOR_UNAVAILABLE',
      'Host Connector access requires a Host-owned client',
    );
  }
}

function readDispose(
  result: StartResult,
  abortController: AbortController,
): (() => void | Promise<void>) | undefined {
  if (result === undefined) return undefined;
  if (!isRecord(result) || typeof result.dispose !== 'function') {
    abortController.abort();
    throw new MiniAppRunnerError(
      'RUNNER_LIFECYCLE_INVALID',
      'Mini App start must return void or include dispose()',
    );
  }
  return result.dispose.bind(result) as () => void | Promise<void>;
}

function createLogger(
  emit: ((message: MiniAppRunnerChildMessage) => void) | undefined,
): MiniAppStartContext['logger'] {
  const log = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => {
    emit?.({
      type: 'miniapp:log',
      level,
      message: boundedLogMessage(message),
      fieldKeys: Object.keys(fields ?? {}),
    });
  };
  return Object.freeze({
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
  });
}

interface RunnerProcess {
  readonly connected?: boolean;
  exitCode?: number;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  send?(message: MiniAppRunnerChildMessage, callback?: (error: Error | null) => void): boolean;
  disconnect?(): void;
}

/** Child executable entry. IPC controls lifecycle; stdio is reserved for Host Connector wire. */
export function runMiniAppHostRunner(
  options: {
    readonly process?: RunnerProcess;
    readonly start?: (init: MiniAppRunnerInitMessage) => Promise<RunningMiniAppModule>;
  } = {},
): void {
  const processPort = options.process ?? nativeProcessPort();
  const send = (message: MiniAppRunnerChildMessage) => {
    if (processPort.connected === false || !processPort.send) return;
    try {
      processPort.send(message);
    } catch {
      // Parent loss is handled by disconnect plus direct Node root ownership.
    }
  };
  const sendStopped = () => flushRunnerMessage(processPort, { type: 'miniapp:stopped' });
  const disconnect = () => {
    if (processPort.connected === false || !processPort.disconnect) return;
    try {
      processPort.disconnect();
    } catch {
      // A concurrent parent disconnect already releases the IPC handle.
    }
  };
  const start = options.start ?? ((init) => startWithStdioConnector(init, send));
  let running: RunningMiniAppModule | undefined;
  let initialized = false;
  let stopping: Promise<void> | undefined;
  const stop = (exitCode: number) => {
    stopping ??= (async () => {
      await running?.stop();
      await sendStopped();
      processPort.exitCode = exitCode;
      disconnect();
    })();
    return stopping;
  };
  const fail = async (error: unknown) => {
    send({ type: 'miniapp:error', code: errorCode(error), errorText: errorText(error) });
    await stop(1);
  };
  const dispatch = (operation: Promise<unknown>) => {
    const observed = dispatchOperation(operation, processPort, () =>
      runnerObservations.delete(observed),
    );
    runnerObservations.add(observed);
  };
  processPort.on('message', (message: unknown) => {
    dispatch(
      (async () => {
        if (isStopMessage(message)) {
          await stop(0);
          return;
        }
        if (!isMiniAppRunnerInitMessage(message) || initialized) {
          await fail(new MiniAppRunnerError('RUNNER_PROTOCOL_ERROR', 'Invalid runner init'));
          return;
        }
        initialized = true;
        try {
          const started = await start(message);
          if (stopping || processPort.connected === false) {
            await started.stop();
            return;
          }
          running = started;
          send({
            type: 'miniapp:started',
            pluginId: message.pluginId,
            processGeneration: message.processGeneration,
            readiness: message.readiness,
          });
        } catch (error) {
          await fail(error);
        }
      })(),
    );
  });
  processPort.once('disconnect', () => dispatch(stop(0)));
  processPort.once('SIGTERM', () => dispatch(stop(0)));
  processPort.once('SIGINT', () => dispatch(stop(0)));
  processPort.once('uncaughtException', (error) => dispatch(fail(error)));
  processPort.once('unhandledRejection', (error) => dispatch(fail(error)));
}

function flushRunnerMessage(
  processPort: RunnerProcess,
  message: MiniAppRunnerChildMessage,
): Promise<void> {
  if (processPort.connected === false || !processPort.send) return Promise.resolve();
  const send = processPort.send.bind(processPort);
  return new Promise((resolve) => {
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      send(message, complete);
    } catch {
      complete();
    }
  });
}

async function dispatchOperation(
  operation: Promise<unknown>,
  processPort: RunnerProcess,
  complete: () => void,
): Promise<void> {
  try {
    await operation;
  } catch {
    processPort.exitCode = 1;
  } finally {
    complete();
  }
}

async function startWithStdioConnector(
  init: MiniAppRunnerInitMessage,
  emit: (message: MiniAppRunnerChildMessage) => void,
): Promise<RunningMiniAppModule> {
  let connector: MiniAppHostConnectorRuntimeClient | undefined;
  const closeConnector = () => {
    if (!connector) return;
    connector.close();
    process.stdin.pause();
  };
  try {
    const running = await startMiniAppModule(init, {
      emit,
      createHostConnector:
        init.hostConnectorPolicy.kind === 'allowlist'
          ? () => {
              connector = createMiniAppHostConnectorRuntimeClient({
                input: process.stdin,
                output: process.stdout,
              });
              return connector.client;
            }
          : undefined,
    });
    return {
      async stop() {
        try {
          await running.stop();
        } finally {
          closeConnector();
        }
      },
    };
  } catch (error) {
    closeConnector();
    throw error;
  }
}

export function isMiniAppRunnerInitMessage(value: unknown): value is MiniAppRunnerInitMessage {
  if (!isRecord(value)) return false;
  const keys = [
    'type',
    'protocolVersion',
    'pluginId',
    'processGeneration',
    'packageRoot',
    'nodeEntry',
    'dataDir',
    'listen',
    'readiness',
    'hostConnectorPolicy',
  ];
  if (!hasExactKeys(value, keys)) return false;
  return (
    value.type === 'miniapp:init' &&
    value.protocolVersion === 1 &&
    hasStringIdentityFields(value) &&
    isListenAddress(value.listen) &&
    isReadinessIdentity(value.readiness) &&
    isConnectorPolicy(value.hostConnectorPolicy)
  );
}

function hasStringIdentityFields(value: Record<string, unknown>): boolean {
  return ['pluginId', 'processGeneration', 'packageRoot', 'nodeEntry', 'dataDir'].every(
    (field) => typeof value[field] === 'string',
  );
}

function isListenAddress(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['host', 'port']) &&
    value.host === '127.0.0.1' &&
    Number.isInteger(value.port)
  );
}

function isReadinessIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['startupToken', 'nodeDigest']) &&
    typeof value.startupToken === 'string' &&
    typeof value.nodeDigest === 'string'
  );
}

function nativeProcessPort(): RunnerProcess {
  return {
    get connected() {
      return process.connected;
    },
    get exitCode() {
      return typeof process.exitCode === 'number' ? process.exitCode : undefined;
    },
    set exitCode(value: number | undefined) {
      process.exitCode = value;
    },
    on(event, listener) {
      process.on(event, listener);
      return this;
    },
    once(event, listener) {
      process.once(event, listener);
      return this;
    },
    send(message, callback) {
      if (!process.send) {
        callback?.(new Error('Runner IPC channel is unavailable'));
        return false;
      }
      return callback ? process.send(message, callback) : process.send(message);
    },
    disconnect() {
      if (process.connected) process.disconnect();
    },
  };
}

function isConnectorPolicy(value: unknown): value is MiniAppHostConnectorPolicy {
  if (!isRecord(value)) return false;
  return value.kind === 'deny-all'
    ? hasExactKeys(value, ['kind'])
    : value.kind === 'allowlist' &&
        hasExactKeys(value, ['kind', 'providers']) &&
        Array.isArray(value.providers) &&
        value.providers.every((provider) => typeof provider === 'string');
}

function isStopMessage(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['type']) && value.type === 'miniapp:stop';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function errorText(value: unknown): string {
  let text: string;
  try {
    const candidate =
      value instanceof Error ? (value.stack ?? `${value.name}: ${value.message}`) : value;
    text = typeof candidate === 'string' ? candidate : String(candidate);
  } catch {
    text = 'Runner error could not be converted to text';
  }
  return boundMiniAppRuntimeErrorText(text, 'runner error text');
}

function boundedLogMessage(message: string): string {
  return message.slice(0, MAX_LOG_MESSAGE_LENGTH);
}

function errorCode(error: unknown): string {
  if (error instanceof MiniAppRunnerError) return error.code;
  return isRecord(error) && error.code === 'EADDRINUSE' ? error.code : 'RUNNER_START_FAILED';
}

/** Re-validates child IPC before a runner failure crosses into the Host runtime. */
export function normalizeMiniAppRunnerFailureCode(code: string): MiniAppRunnerFailureCode {
  if (code === 'EADDRINUSE' || code === 'RUNNER_START_FAILED') return code;
  return MINIAPP_RUNNER_ERROR_CODES.has(code)
    ? (code as MiniAppRunnerErrorCode)
    : 'RUNNER_START_FAILED';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMiniAppHostRunner();
}
