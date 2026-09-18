/**
 * Permission host-utils: registry for permission-specific runtime ports.
 *
 * Mirrors `agent-core/src/cron/host-utils.ts`. Hosts (local-runtime today)
 * call {@link configurePermissionHost} once at startup with concrete
 * implementations of the ports declared in `host-ports.ts`. The permission
 * code (`engine.ts`, the facade, classifier) imports these helpers and
 * resolves the live port at call time so a swap-after-import cycle picks up
 * the host's wiring.
 *
 * Cross-cutting helpers (`logger`, `backgroundCtx`, `AppError`, `nowMs`,
 * region/build-env providers) are permission-owned runtime collaborators.
 * Hosts override them through {@link configurePermissionHost}; otherwise
 * safe test fallbacks are used.
 */

import { randomUUID } from 'node:crypto';

import type { ManagedAuthTokenGetter, PermissionPromptProvider } from './host-ports.js';
import type { PermissionMode } from './types.js';

// ─── Permission-owned cross-cutting helpers ────────────────────────────

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

export interface PermissionDatetimeHelpers {
  nowMs(): number;
  formatLocalMonthDayTime(ts: number | Date): string;
  formatLocalDateTime(ts: number | Date): string;
}

const fallbackDatetimeHelpers: PermissionDatetimeHelpers = {
  nowMs: () => Date.now(),
  formatLocalMonthDayTime: (ts) => {
    const d = ts instanceof Date ? ts : new Date(ts);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  },
  formatLocalDateTime: (ts) => {
    const d = ts instanceof Date ? ts : new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  },
};

let _datetimeHelpers: PermissionDatetimeHelpers = fallbackDatetimeHelpers;

export function nowMs(): number {
  return _datetimeHelpers.nowMs();
}

export function formatLocalMonthDayTime(ts: number | Date): string {
  return _datetimeHelpers.formatLocalMonthDayTime(ts);
}

export function formatLocalDateTime(ts: number | Date): string {
  return _datetimeHelpers.formatLocalDateTime(ts);
}

export type MavisRegion = 'cn' | 'en';
export type MavisBuildEnv = 'test' | 'prod' | 'dev' | 'staging';

export interface PermissionCoreSkillEvolveProposalConfig {
  enabled: boolean;
  eligibleAgents?: string[];
  minMessageCount: number;
}

export interface PermissionCoreConfig {
  beta: {
    autoMemory: boolean;
    promptOverride?: boolean;
  };
  memory: {
    dailyDigest: {
      enabled: boolean;
    };
  };
  contextManagement: {
    disableSystemReminderModels: string[];
  };
  skillEvolve: {
    disableModelPrefixes: string[];
    proposal: PermissionCoreSkillEvolveProposalConfig;
  };
}

/**
 * Config view the permission subsystem reads from the host's runtime config.
 *
 * agent-core stays pure: it declares exactly the fields permission code needs
 * rather than importing the full `@mavis/config` Config (which would violate
 * the agent-core package boundary — agent-core may only depend on protocol /
 * shared). The host (local-runtime / daemon) supplies a config object that
 * structurally satisfies this view; `getRuntimeConfig()` is typed as the narrow
 * `RuntimeCoreConfig`, so we assert to this richer permission-facing view.
 */
export interface PermissionRuntimeConfig extends PermissionCoreConfig {
  /** Root data directory. */
  dataDir: string;
  /** Agents root directory. */
  agentsDir: string;
  /** Active permission mode. */
  permissionMode: PermissionMode;
  /** Cloud classifier tuning. */
  permission: { classifierTimeoutMs: number };
  /** Beta feature flags read by the permission subsystem. */
  beta: PermissionCoreConfig['beta'];
  /** Model provider registry passed to the local LLM client. */
  provider?: unknown;
  /** Default model id ("providerID/modelID"). */
  defaultModel?: string;
  /** Optional lightweight model id; falls back to `defaultModel`. */
  defaultLightModel?: string;
}
export function getPermissionConfig(): PermissionRuntimeConfig {
  return _runtimeConfigProvider.getConfig();
}

export interface PermissionRuntimeConfigProvider {
  getConfig(): PermissionRuntimeConfig;
  getRuntimeRegion(): MavisRegion;
  getRuntimeBuildEnv(): MavisBuildEnv;
  isManagedRuntime(): boolean;
}

const fallbackRuntimeConfigProvider: PermissionRuntimeConfigProvider = {
  getConfig: () => {
    throw new Error(
      '[@mavis/permission] No runtimeConfigProvider registered. Hosts must call ' +
        'configurePermissionHost({ runtimeConfigProvider }) before permission checks run.',
    );
  },
  getRuntimeRegion: () => 'cn',
  getRuntimeBuildEnv: () => 'prod',
  isManagedRuntime: () => false,
};

let _runtimeConfigProvider: PermissionRuntimeConfigProvider = fallbackRuntimeConfigProvider;

export function getRuntimeConfig(): PermissionRuntimeConfig {
  return _runtimeConfigProvider.getConfig();
}

export function getRuntimeRegion(): MavisRegion {
  return _runtimeConfigProvider.getRuntimeRegion();
}

export function getRuntimeBuildEnv(): MavisBuildEnv {
  return _runtimeConfigProvider.getRuntimeBuildEnv();
}

export function isManagedRuntime(): boolean {
  return _runtimeConfigProvider.isManagedRuntime();
}

// ─── Permission-specific port slots ──────────────────────────────────────

let _managedAuthTokenGetter: ManagedAuthTokenGetter = () => undefined;
let _promptProvider: PermissionPromptProvider | undefined;

/**
 * Managed-login token used as the cloud classifier Bearer credential.
 * Returns undefined when unavailable → cloud classifier fail-closes to confirm.
 */
export function getPermissionManagedAuthToken(): string | undefined {
  return _managedAuthTokenGetter();
}

/** Host-resolved permission prompt content. */
export function getPermissionPrompt(name: string): string | undefined {
  return _promptProvider?.resolvePrompt(name);
}

export interface PermissionHostUtils {
  /** Runtime config and environment provider used by permission decisions. */
  runtimeConfigProvider?: PermissionRuntimeConfigProvider;
  /** Managed-login token getter for the cloud classifier Bearer header. */
  managedAuthTokenGetter?: ManagedAuthTokenGetter;
  /** Optional prompt resolver for classifier prompts and operator overrides. */
  promptProvider?: PermissionPromptProvider;
  /** OPTIONAL: host logger for permission internals. */
  logger?: Logger;
  /** OPTIONAL: host metrics reporter for permission internals. */
  metricsReporter?: MetricsReporter;
  /** OPTIONAL: request context factory for background permission work. */
  backgroundCtx?: () => RequestContext;
  /** OPTIONAL: host-compatible AppError implementation. */
  appError?: AppErrorConstructor;
  /** OPTIONAL: host datetime helpers. */
  datetimeHelpers?: Partial<PermissionDatetimeHelpers>;
}

/**
 * Configure the permission-specific port slots. Hosts call this once at
 * startup. Ports left undefined keep safe fallbacks (no token / no local LLM →
 * cloud-or-confirm).
 */
export function configurePermissionHost(opts: PermissionHostUtils): void {
  if (opts.runtimeConfigProvider) _runtimeConfigProvider = opts.runtimeConfigProvider;
  if (opts.managedAuthTokenGetter) _managedAuthTokenGetter = opts.managedAuthTokenGetter;
  if (opts.promptProvider) _promptProvider = opts.promptProvider;
  if (opts.logger) _logger = opts.logger;
  if (opts.metricsReporter) _metricsReporter = opts.metricsReporter;
  if (opts.backgroundCtx) _backgroundCtxFactory = opts.backgroundCtx;
  if (opts.appError) _AppError = opts.appError;
  if (opts.datetimeHelpers) _datetimeHelpers = { ..._datetimeHelpers, ...opts.datetimeHelpers };
}

/** Reset permission host registry to fallbacks. Intended for tests. */
export function resetPermissionHostForTesting(): void {
  _runtimeConfigProvider = fallbackRuntimeConfigProvider;
  _managedAuthTokenGetter = () => undefined;
  _promptProvider = undefined;
  _logger = noopLogger;
  _metricsReporter = noopMetricsReporter;
  _backgroundCtxFactory = () => ({ traceId: randomUUID().replaceAll('-', '') });
  _AppError = FallbackAppError as AppErrorConstructor;
  _datetimeHelpers = fallbackDatetimeHelpers;
}
