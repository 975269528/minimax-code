import { getRuntimeBuildEnv, isInternalBuild } from '@mavis/config';

import {
  createLlmCaptureRecorder,
  type LlmCaptureRecorderWithFetch,
  wrapResolvedFetchForCapture,
} from './capture-recorder.js';
import type { InspectorBuildVariant, InspectorSessionIdentity } from './contracts.js';
import type { AppDb } from '../../infra/db/client.js';
import { LlmContextInspectorHistoryStore } from './history-store.js';
import { LlmContextInspectorService } from './service.js';

export interface ComposeInspectorOptions {
  readonly dataDir: string;
  readonly db: AppDb;
  readonly resolveSession: (sessionId: string) => Promise<InspectorSessionIdentity | undefined>;
  readonly runtimeOwnerKind?: string | undefined;
  /** Test seam; production reads the runtime build env. */
  readonly buildVariantOverride?: InspectorBuildVariant;
}

export interface ComposedInspector {
  readonly service: LlmContextInspectorService;
  readonly createRecorder: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => LlmCaptureRecorderWithFetch;
  readonly wrapResolvedFetch: (baseFetch: typeof fetch) => typeof fetch;
}

/** Internal Electron builds, plus explicitly opted-in TUI processes, can capture. */
export function composeLlmContextInspector(
  options: ComposeInspectorOptions,
): Promise<ComposedInspector> | undefined {
  const forceCaptureEnabled =
    options.runtimeOwnerKind === 'tui' && process.env.MAVIS_TUI_LLM_CONTEXT_INSPECTOR === '1';
  if (options.runtimeOwnerKind !== 'electron' && !forceCaptureEnabled) return undefined;
  const buildVariant = options.buildVariantOverride ?? resolveBuildVariant();
  if (buildVariant === 'unavailable' && !forceCaptureEnabled) return undefined;
  return composeAvailableInspector(
    options,
    buildVariant === 'unavailable' ? 'internal' : buildVariant,
    forceCaptureEnabled,
  );
}

async function composeAvailableInspector(
  options: ComposeInspectorOptions,
  buildVariant: Exclude<InspectorBuildVariant, 'unavailable'>,
  forceCaptureEnabled: boolean,
): Promise<ComposedInspector> {
  const store = new LlmContextInspectorHistoryStore({
    dataDir: options.dataDir,
    resolveSession: options.resolveSession,
    runtimeOwnerKind: options.runtimeOwnerKind === 'tui' ? 'tui' : 'electron',
  });
  const service = new LlmContextInspectorService(store, options.db, buildVariant, Date.now);
  await service.initialize(forceCaptureEnabled);

  return {
    service,
    createRecorder: (input) =>
      createLlmCaptureRecorder({
        sessionId: input.sessionId,
        turnId: input.turnId,
        sink: {
          persistSettledCall: (record) => store.persistSettledCall(record),
          recordToolStarted: (event) => store.recordToolStarted(event),
          recordToolCompleted: (event) => store.recordToolCompleted(event),
        },
        captureState: () => service.captureState(),
        nowMs: Date.now,
      }),
    wrapResolvedFetch: wrapResolvedFetchForCapture,
  };
}

function resolveBuildVariant(): InspectorBuildVariant {
  switch (getRuntimeBuildEnv()) {
    case 'dev':
      return 'dev';
    case 'test':
      return 'test';
    case 'staging':
      return 'internal';
    case 'prod':
      return isInternalBuild() ? 'internal' : 'unavailable';
    default:
      return 'unavailable';
  }
}
