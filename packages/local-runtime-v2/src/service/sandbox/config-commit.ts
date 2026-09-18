import { parseSandboxConfig, type SandboxConfig } from '@mavis/config';

import { SandboxError, isSandboxError } from './sandbox-errors.js';

export type SandboxActivation =
  | 'applied-next-invocation'
  | 'applied-at-wrap'
  | 'applied-live-global'
  | 'initialized'
  | 'disabled-retiring';

export type SandboxApplyResult = {
  readonly effectiveGeneration: number;
  readonly activation: SandboxActivation;
  readonly changedFields: readonly string[];
};

export type SandboxConfigCommitWriter = (candidate: SandboxConfig) => Promise<void>;

export function parseSandboxCandidate(candidate: unknown): SandboxConfig {
  try {
    return parseSandboxConfig(candidate);
  } catch {
    throw new SandboxError('SANDBOX_CONFIG_INVALID', 'parse', 'Sandbox configuration is invalid');
  }
}

export function sandboxChangedFields(
  previous: SandboxConfig,
  next: SandboxConfig,
): readonly string[] {
  const changed: string[] = [];
  if (previous.enabled !== next.enabled) changed.push('enabled');
  if (previous.filesystem.policy.mode !== next.filesystem.policy.mode) {
    changed.push('filesystem.policy.mode');
  }
  if (!sameStrings(previous.filesystem.denyRead, next.filesystem.denyRead)) {
    changed.push('filesystem.denyRead');
  }
  if (!sameStrings(previous.filesystem.denyWrite, next.filesystem.denyWrite)) {
    changed.push('filesystem.denyWrite');
  }
  if (previous.network.policy.mode !== next.network.policy.mode) {
    changed.push('network.policy.mode');
  }
  if (!sameStrings(previous.network.deniedDomains, next.network.deniedDomains)) {
    changed.push('network.deniedDomains');
  }
  if (previous.localAccess !== next.localAccess) changed.push('localAccess');
  return changed;
}

export function activationForChangedFields(changedFields: readonly string[]): SandboxActivation {
  if (
    changedFields.some(
      (field) =>
        field === 'enabled' ||
        field === 'filesystem.policy.mode' ||
        field === 'filesystem.denyRead' ||
        field === 'filesystem.denyWrite',
    )
  ) {
    return 'applied-next-invocation';
  }
  if (changedFields.some((field) => field === 'localAccess')) {
    return 'applied-at-wrap';
  }
  return 'applied-live-global';
}

export function asSandboxConfigInvalid(error: unknown, fieldPath?: string): SandboxError {
  if (isSandboxError(error) && error.code === 'SANDBOX_CONFIG_INVALID') return error;
  return new SandboxError(
    'SANDBOX_CONFIG_INVALID',
    'parse',
    'Sandbox configuration cannot be enforced',
    fieldPath,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
