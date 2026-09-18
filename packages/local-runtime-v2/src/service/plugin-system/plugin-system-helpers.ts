import type {
  AgentHostTurnCapabilityPreparation,
  AgentHostTurnCapabilityView,
} from '../turn-system/index.js';
import type { ConnectorRuntimePort } from './app/runtime.js';
import { PluginSystemError } from './errors.js';
import type { CachedPluginPackage } from './plugin/runtime/repository.js';
import type { PluginSnapshot } from './plugin/runtime/snapshot-builder.js';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function runAfter<T>(prior: Promise<void>, operation: () => Promise<T>): Promise<T> {
  await prior;
  return operation();
}

export async function preparePluginSystemTurnCapabilities(
  connectorRuntime: ConnectorRuntimePort,
  signal?: AbortSignal,
): Promise<AgentHostTurnCapabilityPreparation> {
  const runtimeToolBindings = await connectorRuntime.resolveBindingsForTurn?.(signal);
  const runtimeTools = runtimeToolBindings
    ? runtimeToolBindings.map((binding) => binding.tool)
    : await connectorRuntime.resolveForTurn(signal);
  return freeze({
    runtimeTools: freeze(runtimeTools),
    runtimeToolBindings: freeze([...(runtimeToolBindings ?? [])]),
  });
}

export function capturePluginSystemTurnCapabilities(
  snapshot: AgentHostTurnCapabilityView,
  preparation?: AgentHostTurnCapabilityPreparation,
): AgentHostTurnCapabilityView {
  return freeze({
    ...snapshot,
    runtimeTools: mergeRuntimeTools(preparation?.runtimeTools ?? [], snapshot.runtimeTools),
    runtimeToolBindings: mergeRuntimeToolBindings(
      preparation?.runtimeToolBindings ?? [],
      snapshot.runtimeToolBindings,
    ),
  });
}

function mergeRuntimeToolBindings(
  primary: readonly AgentHostTurnCapabilityView['runtimeToolBindings'][number][],
  secondary: readonly AgentHostTurnCapabilityView['runtimeToolBindings'][number][],
): AgentHostTurnCapabilityView['runtimeToolBindings'] {
  const names = new Set<string>();
  return freeze(
    [...primary, ...secondary].filter((binding) => keepFirstName(binding.tool.def.name, names)),
  );
}

function mergeRuntimeTools(
  primary: readonly AgentHostTurnCapabilityView['runtimeTools'][number][],
  secondary: readonly AgentHostTurnCapabilityView['runtimeTools'][number][],
): AgentHostTurnCapabilityView['runtimeTools'] {
  const names = new Set<string>();
  return freeze([...primary, ...secondary].filter((tool) => keepFirstName(tool.def.name, names)));
}

function keepFirstName(name: string, names: Set<string>): boolean {
  const key = name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
  if (names.has(key)) return false;
  names.add(key);
  return true;
}

export function assertPluginSystemPublicationAttached(attached: boolean): void {
  if (!attached) {
    throw new PluginSystemError('NOT_ATTACHED', 'PluginSystem publication port is not attached');
  }
}

export async function ignoreFailure(promise: Promise<unknown> | undefined): Promise<void> {
  try {
    await promise;
  } catch {
    // Queue and shutdown cleanup deliberately continue after an operation fails.
  }
}

export async function runAllFinally(
  operations: readonly (() => Promise<unknown> | undefined)[],
): Promise<void> {
  let hasError = false;
  let firstError: unknown;
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      if (!hasError) firstError = error;
      hasError = true;
    }
  }
  if (hasError) throw firstError;
}

/** Waits for best-effort background work without allowing it to block admission forever. */
export async function waitUntilSettledOrDeadline(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function waitForScopedOperation(
  operation: { readonly scopeKey: string; readonly operation: Promise<void> } | undefined,
  currentScopeKey: string,
  timeoutMs = 20_000,
): Promise<void> {
  if (!operation || operation.scopeKey !== currentScopeKey) return Promise.resolve();
  return waitUntilSettledOrDeadline(ignoreFailure(operation.operation), timeoutMs);
}

export function settleInBackground(promise: Promise<unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises -- detached background work is fail-closed by ignoreFailure or its own error boundary
  (async () => {
    await ignoreFailure(promise);
  })();
}

export function findEnabledCachedPackage(
  installations: ReadonlyMap<
    string,
    {
      readonly installed: boolean;
      readonly enabled: boolean;
      readonly cachedPackages: readonly CachedPluginPackage[];
    }
  >,
  contentDigest: string,
): CachedPluginPackage | undefined {
  for (const installation of installations.values()) {
    if (!installation.installed || !installation.enabled) continue;
    const cached = installation.cachedPackages.find((item) => item.contentDigest === contentDigest);
    if (cached) return cached;
  }
  return undefined;
}

export function scopeKey(scope: { principalId: string; deployment: string } | undefined): string {
  return scope ? `${scope.principalId}\0${scope.deployment}` : 'custom-only';
}

export function normalizedPluginName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

export function findLocalPlugin(
  snapshot: PluginSnapshot,
  pluginName: string,
): PluginSnapshot['localPlugins'][number] | undefined {
  const key = normalizedPluginName(pluginName);
  return snapshot.localPlugins.find((plugin) => normalizedPluginName(plugin.name) === key);
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
