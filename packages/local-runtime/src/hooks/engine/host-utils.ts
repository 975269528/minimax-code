/** Logging and metrics for product-internal tool lifecycle handlers. */
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

export interface HookRegistryHostUtils {
  logger?: Logger;
  metricsReporter?: MetricsReporter;
}

export function configureHookRegistryHost(opts: HookRegistryHostUtils): void {
  if (opts.logger) _logger = opts.logger;
  if (opts.metricsReporter) _metricsReporter = opts.metricsReporter;
}
