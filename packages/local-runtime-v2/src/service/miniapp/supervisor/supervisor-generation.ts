import type {
  MiniAppCandidate,
  MiniAppNodeRuntime,
  MiniAppPersistedState,
  MiniAppPublishedView,
  MiniAppStatus,
} from '../contracts.js';
import { MiniAppError } from '../errors.js';

export interface MiniAppGeneration {
  readonly candidate: MiniAppCandidate;
  view: MiniAppPublishedView;
  readonly leases: Set<string>;
  accepting: boolean;
  runtime?: MiniAppNodeRuntime;
  startPromise?: Promise<MiniAppNodeRuntime>;
  startController?: AbortController;
  idleTimer?: { cancel(): void };
  idleStopPromise?: Promise<void>;
  retirementPromise?: Promise<void>;
  retirementPendingFinalization?: boolean;
}

export function activeStatusPhase(
  active: MiniAppGeneration,
  hasFailure: boolean,
): MiniAppStatus['phase'] {
  if (active.runtime) return 'active';
  if (hasFailure) return 'failed';
  return active.startPromise ? 'starting' : 'cold';
}

export function publishedView(
  candidate: MiniAppCandidate,
  miniAppGeneration: string,
  runtime?: MiniAppNodeRuntime,
): MiniAppPublishedView {
  return {
    pluginId: candidate.pluginId,
    miniAppGeneration,
    packageRoot: candidate.packageRoot,
    packageDigest: candidate.packageDigest,
    clientDigest: candidate.clientDigest,
    surfacePath: candidate.surfacePath,
    nodeDigest: candidate.nodeDigest,
    lifecycle: candidate.lifecycle,
    ...(runtime ? { processGeneration: runtime.processGeneration, origin: runtime.origin } : {}),
  };
}

export function persistedState(
  candidate: MiniAppCandidate,
  runtime: MiniAppNodeRuntime | undefined,
  updatedAtMs: number,
): MiniAppPersistedState {
  return {
    pluginId: candidate.pluginId,
    acceptedSourceDigest: candidate.packageDigest,
    clientDigest: candidate.clientDigest,
    nodeDigest: candidate.nodeDigest,
    ...(runtime
      ? {
          preferredPort: runtime.port,
        }
      : {}),
    updatedAtMs,
  };
}

export function isReusableGeneration(
  generation: MiniAppGeneration,
  candidate: MiniAppCandidate,
): generation is MiniAppGeneration & {
  readonly candidate: MiniAppCandidate;
  runtime: MiniAppNodeRuntime;
} {
  if (!generation.runtime || hasRuntimeTransition(generation)) return false;
  return (
    sameProcessContract(generation.candidate, candidate) &&
    generation.runtime.nodeDigest === candidate.nodeDigest
  );
}

export function assertReusableRuntimeCurrent(
  active: ReadonlyMap<string, MiniAppGeneration>,
  candidate: MiniAppCandidate,
  reusable:
    | { readonly generation: MiniAppGeneration; readonly runtime: MiniAppNodeRuntime }
    | undefined,
): void {
  if (!reusable) return;
  const generation = active.get(candidate.pluginId);
  if (
    generation === reusable.generation &&
    generation &&
    isReusableGeneration(generation, candidate) &&
    generation.runtime === reusable.runtime
  ) {
    return;
  }
  throw new MiniAppError('SUPERSEDED', 'Reusable MiniApp runtime changed before commit');
}

export function assertGenerationRunCurrent(input: {
  readonly active: ReadonlyMap<string, MiniAppGeneration>;
  readonly pluginId: string;
  readonly runId: string;
  readonly unavailable: boolean;
}): undefined {
  const generation = input.active.get(input.pluginId);
  if (
    !input.unavailable &&
    generation?.accepting &&
    generation.runtime?.processGeneration === input.runId &&
    generation.view.processGeneration === input.runId
  ) {
    return undefined;
  }
  throw new MiniAppError(
    'SERVICE_RESTARTED',
    'Mini App service changed before this operation could be dispatched',
  );
}

export function scheduleTimeout(delayMs: number, callback: () => void): { cancel(): void } {
  const timer = setTimeout(callback, Math.max(0, delayMs));
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}

function sameProcessContract(current: MiniAppCandidate, candidate: MiniAppCandidate): boolean {
  return (
    current.nodeDigest === candidate.nodeDigest &&
    current.nodeEntry === candidate.nodeEntry &&
    canonicalMcpEndpoints(current) === canonicalMcpEndpoints(candidate) &&
    canonicalHostConnectorPolicy(current) === canonicalHostConnectorPolicy(candidate)
  );
}

function hasRuntimeTransition(generation: MiniAppGeneration): boolean {
  return Boolean(
    generation.startPromise ||
    generation.startController ||
    generation.idleTimer ||
    generation.idleStopPromise,
  );
}

function canonicalMcpEndpoints(candidate: MiniAppCandidate): string {
  return JSON.stringify(
    candidate.mcpEndpoints
      .map((endpoint) => [endpoint.id, endpoint.path] as const)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
}

function canonicalHostConnectorPolicy(candidate: MiniAppCandidate): string {
  const policy = candidate.hostConnectorPolicy;
  return policy.kind === 'deny-all'
    ? policy.kind
    : JSON.stringify([policy.kind, [...policy.providers].sort()]);
}
