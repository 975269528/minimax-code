/**
 * Cron host-utils: registry for cron-specific runtime ports.
 *
 * Hosts (daemon today, cloud-runtime later) call {@link configureCronHost}
 * once at startup with concrete implementations of the ports declared in
 * `host-ports.ts`. The cron orchestrator code (`executor.ts`,
 * `registry.ts`) imports these helpers and resolves the live port at
 * call time so a swap-after-import cycle picks up the host's wiring.
 *
 * Cross-cutting helpers (`logger`, `getMetricsReporter`, `backgroundCtx`,
 * `AppError`, `nowMs`, `formatLocalMonthDayTime`) are cron-owned runtime
 * collaborators. Hosts override them through {@link configureCronHost};
 * otherwise safe test fallbacks are used.
 */

import { randomUUID } from 'node:crypto';

import type {
  AgentSpawnerPort,
  ChannelDeliveryPort,
  MessageQueuePort,
  SessionLifecyclePort,
  CronStorePort,
} from './host-ports.js';

// ─── Cron-owned cross-cutting helpers ─────────────────────────────────

export interface RequestContext {
  traceId: string;
  callerAgent?: string;
  callerSession?: string;
  locale?: string;
}

export interface Logger {
  trace(arg: unknown, msg?: string, ...args: unknown[]): void;
  debug(arg: unknown, msg?: string, ...args: unknown[]): void;
  info(arg: unknown, msg?: string, ...args: unknown[]): void;
  warn(arg: unknown, msg?: string, ...args: unknown[]): void;
  error(arg: unknown, msg?: string, ...args: unknown[]): void;
  fatal(arg: unknown, msg?: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): Logger;
}

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

let _logger: Logger = noopLogger;

export const logger: Logger = {
  trace: (...args) => _logger.trace(...args),
  debug: (...args) => _logger.debug(...args),
  info: (...args) => _logger.info(...args),
  warn: (...args) => _logger.warn(...args),
  error: (...args) => _logger.error(...args),
  fatal: (...args) => _logger.fatal(...args),
  child: (bindings) => buildLiveChild(bindings),
};

function buildLiveChild(bindings: Record<string, unknown>): Logger {
  return {
    trace: (...args) => _logger.child(bindings).trace(...args),
    debug: (...args) => _logger.child(bindings).debug(...args),
    info: (...args) => _logger.child(bindings).info(...args),
    warn: (...args) => _logger.child(bindings).warn(...args),
    error: (...args) => _logger.child(bindings).error(...args),
    fatal: (...args) => _logger.child(bindings).fatal(...args),
    child: (extra) => buildLiveChild({ ...bindings, ...extra }),
  };
}

let _backgroundCtxFactory: () => RequestContext = () => ({
  traceId: randomUUID().replaceAll('-', ''),
});

export function backgroundCtx(): RequestContext {
  return _backgroundCtxFactory();
}

export type MetricsTags = Record<string, string>;

export interface MetricsReporter {
  incr(name: string, tags?: MetricsTags): void;
  gauge(name: string, value: number, tags?: MetricsTags): void;
  latency(name: string, durationMs: number, tags?: MetricsTags): void;
}

const noopMetricsReporter: MetricsReporter = {
  incr: () => {},
  gauge: () => {},
  latency: () => {},
};

let _metricsReporter: MetricsReporter = noopMetricsReporter;

export function getMetricsReporter(): MetricsReporter {
  return _metricsReporter;
}

export interface AppErrorConstructor {
  new (
    message: string,
    code: string,
    statusCode?: number,
    options?: ErrorOptions,
  ): Error & {
    code: string;
    statusCode: number;
  };
}

class FallbackAppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode = 500, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

let _AppError: AppErrorConstructor = FallbackAppError as AppErrorConstructor;

export const AppError = new Proxy(FallbackAppError, {
  construct(_target, args) {
    const [message, code, statusCode, options] = args as [string, string, number?, ErrorOptions?];
    return new _AppError(message, code, statusCode ?? 500, options);
  },
  get(_target, prop) {
    return Reflect.get(_AppError, prop);
  },
}) as unknown as AppErrorConstructor;

export interface CronDatetimeHelpers {
  nowMs(): number;
  formatLocalMonthDayTime(ts: number | Date): string;
}

const fallbackDatetimeHelpers: CronDatetimeHelpers = {
  nowMs: () => Date.now(),
  formatLocalMonthDayTime: (ts) => {
    const d = ts instanceof Date ? ts : new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  },
};

let _datetimeHelpers: CronDatetimeHelpers = fallbackDatetimeHelpers;

export function nowMs(): number {
  return _datetimeHelpers.nowMs();
}

export function formatLocalMonthDayTime(ts: number | Date): string {
  return _datetimeHelpers.formatLocalMonthDayTime(ts);
}

// ─── Cron-specific port slots ────────────────────────────────────────────

const fallbackThrow = (label: string): never => {
  throw new Error(
    `[@mavis/cron] No ${label} registered. Hosts must call ` +
      `configureCronHost(...) before cron orchestration runs.`,
  );
};

const fallbackCronStore: CronStorePort = {
  configPath: () => Promise.resolve(fallbackThrow('CronStorePort')),
  get: () => Promise.resolve(fallbackThrow('CronStorePort')),
  listByAgent: () => Promise.resolve(fallbackThrow('CronStorePort')),
  listAll: () => Promise.resolve(fallbackThrow('CronStorePort')),
  create: () => Promise.resolve(fallbackThrow('CronStorePort')),
  update: () => Promise.resolve(fallbackThrow('CronStorePort')),
  delete: () => Promise.resolve(fallbackThrow('CronStorePort')),
  appendSessionRun: () => Promise.resolve(fallbackThrow('CronStorePort')),
  getSessionHistory: () => Promise.resolve(fallbackThrow('CronStorePort')),
  replaceSessionHistory: () => Promise.resolve(fallbackThrow('CronStorePort')),
  deleteSessionHistory: () => Promise.resolve(fallbackThrow('CronStorePort')),
};

const fallbackSessionLifecycle: SessionLifecyclePort = {
  getRootSession: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
  getSession: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
  getSessionStatus: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
  setSessionArchived: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
  deleteSession: () => Promise.resolve(fallbackThrow('SessionLifecyclePort')),
};

const fallbackAgentSpawner: AgentSpawnerPort = {
  newSession: () => Promise.resolve(fallbackThrow('AgentSpawnerPort')),
};

let _channelDelivery: ChannelDeliveryPort | undefined;
let _messageQueue: MessageQueuePort | undefined;
let _sessionLifecycle: SessionLifecyclePort = fallbackSessionLifecycle;
let _agentSpawner: AgentSpawnerPort = fallbackAgentSpawner;
let _cronStore: CronStorePort = fallbackCronStore;

export function getCronStore(): CronStorePort {
  return _cronStore;
}

export function getSessionLifecycle(): SessionLifecyclePort {
  return _sessionLifecycle;
}

export function getAgentSpawner(): AgentSpawnerPort {
  return _agentSpawner;
}

export function getChannelDelivery(): ChannelDeliveryPort | undefined {
  return _channelDelivery;
}

export function getMessageQueue(): MessageQueuePort | undefined {
  return _messageQueue;
}

// ─── Configuration entry point ───────────────────────────────────────────

export interface CronHostUtils {
  /** REQUIRED: persistent cron config + history store. */
  cronStore?: CronStorePort;
  /** REQUIRED: session lookup / archive / delete used during cron runs. */
  sessionLifecycle?: SessionLifecyclePort;
  /** REQUIRED for `session.mode === 'new'` cron tasks. */
  agentSpawner?: AgentSpawnerPort;
  /** OPTIONAL: channel delivery target for cron output (skipped if absent). */
  channelDelivery?: ChannelDeliveryPort;
  /** OPTIONAL: bounded-concurrency lane queue (immediate dispatch if absent). */
  messageQueue?: MessageQueuePort;
  /** OPTIONAL: host logger for cron internals. */
  logger?: Logger;
  /** OPTIONAL: host metrics reporter for cron internals. */
  metricsReporter?: MetricsReporter;
  /** OPTIONAL: request context factory for background cron work. */
  backgroundCtx?: () => RequestContext;
  /** OPTIONAL: host-compatible AppError implementation. */
  appError?: AppErrorConstructor;
  /** OPTIONAL: host datetime helpers. */
  datetimeHelpers?: Partial<CronDatetimeHelpers>;
}

/**
 * Configure the cron-specific port slots.
 *
 * Daemon container calls this once during `initRuntime` after building
 * the concrete `CronStore`, `SessionService`, `AgentManager`,
 * `MultiChannelClient`, and `MessageQueue` instances. Tests can inject
 * stubs via partial options; ports left undefined keep their fallbacks
 * (which throw with a clear message on first use).
 */
export function configureCronHost(opts: CronHostUtils): void {
  if (opts.cronStore) _cronStore = opts.cronStore;
  if (opts.sessionLifecycle) _sessionLifecycle = opts.sessionLifecycle;
  if (opts.agentSpawner) _agentSpawner = opts.agentSpawner;
  if (opts.channelDelivery) _channelDelivery = opts.channelDelivery;
  if (opts.messageQueue) _messageQueue = opts.messageQueue;
  if (opts.logger) _logger = opts.logger;
  if (opts.metricsReporter) _metricsReporter = opts.metricsReporter;
  if (opts.backgroundCtx) _backgroundCtxFactory = opts.backgroundCtx;
  if (opts.appError) _AppError = opts.appError;
  if (opts.datetimeHelpers) _datetimeHelpers = { ..._datetimeHelpers, ...opts.datetimeHelpers };
}

/**
 * Reset the cron host registry to fallbacks. Intended for tests; daemon
 * production code should call {@link configureCronHost} once at startup.
 */
export function resetCronHostForTesting(): void {
  _cronStore = fallbackCronStore;
  _sessionLifecycle = fallbackSessionLifecycle;
  _agentSpawner = fallbackAgentSpawner;
  _channelDelivery = undefined;
  _messageQueue = undefined;
  _logger = noopLogger;
  _metricsReporter = noopMetricsReporter;
  _backgroundCtxFactory = () => ({ traceId: randomUUID().replaceAll('-', '') });
  _AppError = FallbackAppError as AppErrorConstructor;
  _datetimeHelpers = fallbackDatetimeHelpers;
}
