import { join } from 'node:path';

import {
  canonicalActiveHistoryRevision,
  type CanonicalHistoryEnvelope,
} from '../../../sessions/representation/canonical-history-contract.js';
import { safeHistoryPathSegment, type SessionHistoryPaths } from '../session-history-paths.js';

export interface HistoryMutationStagingManifest {
  readonly schemaVersion: 1;
  readonly kind: 'rewind';
  readonly sessionId: string;
  readonly operationId: string;
  readonly sourceGeneration: number;
  readonly generation: number;
  readonly sourceRevision: string;
  readonly targetRevision: string;
  readonly snapshots: readonly HistoryMutationStagingSnapshot[];
  readonly operationData?: unknown;
}

interface HistoryMutationStagingSnapshot {
  readonly generation: number;
  readonly fileName: string;
  readonly revision: string;
}

interface RewindStagingInput {
  readonly sessionId: string;
  readonly operationId: string;
  readonly sourceGeneration?: number;
  readonly generation: number;
  readonly expectedRevision: string;
  readonly active: readonly CanonicalHistoryEnvelope[];
  readonly snapshots: readonly HistoryMutationStagingSnapshot[];
  readonly operationData?: unknown;
}

export function historyMutationStagingPaths(
  paths: SessionHistoryPaths,
  operationId: string,
): SessionHistoryPaths {
  const sessionDir = join(
    paths.sessionDir,
    `.history-mutation-${safeHistoryPathSegment(operationId)}`,
  );
  return {
    ...paths,
    sessionDir,
    manifest: join(sessionDir, 'manifest.json'),
    messages: join(sessionDir, 'messages.jsonl'),
    snapshots: join(sessionDir, 'snapshots'),
    reports: join(sessionDir, 'reports'),
  };
}

export function toHistoryMutationStagingManifest(
  input: RewindStagingInput,
): HistoryMutationStagingManifest {
  return {
    schemaVersion: 1,
    kind: 'rewind',
    sessionId: input.sessionId,
    operationId: input.operationId,
    sourceGeneration: input.sourceGeneration ?? input.generation,
    generation: input.generation,
    sourceRevision: input.expectedRevision,
    targetRevision: canonicalActiveHistoryRevision(input.active),
    snapshots: input.snapshots.map(({ generation, fileName, revision }) => ({
      generation,
      fileName,
      revision,
    })),
    ...(input.operationData === undefined ? {} : { operationData: input.operationData }),
  };
}

export function decodeHistoryMutationStagingManifest(
  raw: string,
  expected: { readonly sessionId: string; readonly operationId: string },
): HistoryMutationStagingManifest {
  const value = JSON.parse(raw) as unknown;
  if (!isManifest(value, expected)) {
    throw new Error('Invalid history mutation staging manifest');
  }
  const snapshots = value.snapshots.map(decodeSnapshot);
  return {
    schemaVersion: 1,
    kind: 'rewind',
    sessionId: expected.sessionId,
    operationId: expected.operationId,
    sourceGeneration: value.sourceGeneration ?? value.generation,
    generation: value.generation,
    sourceRevision: value.sourceRevision,
    targetRevision: value.targetRevision,
    snapshots,
    ...(value.operationData === undefined ? {} : { operationData: value.operationData }),
  };
}

type EncodedManifest = Omit<HistoryMutationStagingManifest, 'snapshots' | 'sourceGeneration'> & {
  readonly sourceGeneration?: number;
  readonly snapshots: readonly unknown[];
};

function isManifest(
  value: unknown,
  expected: { readonly sessionId: string; readonly operationId: string },
): value is EncodedManifest {
  return isManifestIdentity(value, expected) && hasManifestPayload(value);
}

function isManifestIdentity(
  value: unknown,
  expected: { readonly sessionId: string; readonly operationId: string },
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    value.kind === 'rewind' &&
    value.sessionId === expected.sessionId &&
    value.operationId === expected.operationId
  );
}

function hasManifestPayload(value: Record<string, unknown>): value is EncodedManifest {
  return (
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    (value.sourceGeneration === undefined ||
      (typeof value.sourceGeneration === 'number' &&
        Number.isSafeInteger(value.sourceGeneration) &&
        value.sourceGeneration >= 0)) &&
    typeof value.sourceRevision === 'string' &&
    typeof value.targetRevision === 'string' &&
    Array.isArray(value.snapshots)
  );
}

function decodeSnapshot(value: unknown): HistoryMutationStagingSnapshot {
  if (!isSnapshot(value)) throw new Error('Invalid history mutation staging snapshot');
  return value;
}

function isSnapshot(value: unknown): value is HistoryMutationStagingSnapshot {
  return (
    isRecord(value) &&
    typeof value.generation === 'number' &&
    Number.isSafeInteger(value.generation) &&
    typeof value.fileName === 'string' &&
    typeof value.revision === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
