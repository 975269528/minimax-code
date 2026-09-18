import type { SandboxLocalAccess } from '@mavis/config';

import type {
  PreparedNetworkPolicy,
  SandboxBackendIdForTest,
  SandboxEffectivePolicy,
} from './types.js';

export interface SandboxBackendHandle {
  readonly id: string;
  readonly backendId: SandboxBackendIdForTest;
}

type SandboxInvocationPolicySnapshot = {
  readonly filesystem: SandboxEffectivePolicy['filesystem'];
};

export type CurrentEffectiveState = {
  readonly effectiveGeneration: number;
  readonly enabled: boolean;
  readonly backendHandle?: SandboxBackendHandle;
  readonly invocationPolicy: SandboxInvocationPolicySnapshot;
  readonly liveNetworkPolicy?: PreparedNetworkPolicy;
  readonly wrapLocalAccess: SandboxLocalAccess;
  readonly compiledBackendPolicy?: SandboxEffectivePolicy;
};

/**
 * JavaScript runs this owner on one event loop, so one reference assignment is
 * the atomic publish point. Every published snapshot is cloned and frozen.
 */
export class CurrentEffectiveStateStore {
  #current: CurrentEffectiveState;

  constructor(initial: CurrentEffectiveState) {
    this.#current = freezeState(initial);
  }

  load(): CurrentEffectiveState {
    return this.#current;
  }

  publish(next: CurrentEffectiveState): CurrentEffectiveState {
    if (next.effectiveGeneration <= this.#current.effectiveGeneration) {
      throw new Error('Sandbox effective generation must increase');
    }
    const published = freezeState(next);
    this.#current = published;
    return published;
  }
}

function freezeState(input: CurrentEffectiveState): CurrentEffectiveState {
  const compiled = input.compiledBackendPolicy
    ? freezeEffectivePolicy(input.compiledBackendPolicy)
    : undefined;
  const filesystem = Object.freeze({
    mode: input.invocationPolicy.filesystem.mode,
    allowWrite: Object.freeze([...input.invocationPolicy.filesystem.allowWrite]),
    unlinkAllowOnly: Object.freeze([...input.invocationPolicy.filesystem.unlinkAllowOnly]),
    denyRead: Object.freeze([...input.invocationPolicy.filesystem.denyRead]),
    denyWrite: Object.freeze([...input.invocationPolicy.filesystem.denyWrite]),
  });
  return Object.freeze({
    effectiveGeneration: input.effectiveGeneration,
    enabled: input.enabled,
    ...(input.backendHandle ? { backendHandle: Object.freeze({ ...input.backendHandle }) } : {}),
    invocationPolicy: Object.freeze({ filesystem }),
    ...(input.liveNetworkPolicy
      ? { liveNetworkPolicy: Object.freeze({ ...input.liveNetworkPolicy }) }
      : {}),
    wrapLocalAccess: input.wrapLocalAccess,
    ...(compiled ? { compiledBackendPolicy: compiled } : {}),
  });
}

function freezeEffectivePolicy(input: SandboxEffectivePolicy): SandboxEffectivePolicy {
  return Object.freeze({
    enabled: input.enabled,
    filesystem: Object.freeze({
      mode: input.filesystem.mode,
      allowWrite: Object.freeze([...input.filesystem.allowWrite]),
      unlinkAllowOnly: Object.freeze([...input.filesystem.unlinkAllowOnly]),
      denyRead: Object.freeze([...input.filesystem.denyRead]),
      denyWrite: Object.freeze([...input.filesystem.denyWrite]),
    }),
    network: Object.freeze({
      mode: input.network.mode,
      enforce: input.network.enforce,
      allowedDomains: Object.freeze([]) as readonly [],
      deniedDomains: Object.freeze([...input.network.deniedDomains]),
      strictAllowlist: true,
      allowAll: input.network.allowAll,
    }),
    localAccess: input.localAccess,
  });
}
