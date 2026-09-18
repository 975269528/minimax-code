import type {
  CapturedPayloadState,
  InspectorBuildVariant,
  InspectorSessionSummary,
  StoredCallSummary,
  StoredTurnSummary,
} from './contracts.js';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { LlmContextInspectorServiceError } from './errors.js';
import type { LlmContextInspectorHistoryStore } from './history-store.js';
import { compareContextPrefix, type PrefixComparison } from './prefix-comparator.js';
import type { AppDb } from '../../infra/db/client.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';

const CAPTURE_PREFERENCE_KEY = 'llm-context-inspector.capture';

interface PersistedCapturePreference {
  readonly version: 1;
  readonly enabled: boolean;
  readonly captureEpoch: number;
}

export interface InspectorCallSummary extends StoredCallSummary {
  readonly prefixComparison: PrefixComparison;
}

export interface InspectorTurnSummary extends Omit<StoredTurnSummary, 'calls'> {
  readonly calls: readonly InspectorCallSummary[];
}

interface InspectorOverview {
  readonly turns: readonly InspectorTurnSummary[];
}

export interface OverviewResult {
  readonly revision: string;
  readonly unchanged: boolean;
  readonly overview?: InspectorOverview;
}

export interface CallDetailResult {
  readonly callId: string;
  readonly requestState: CapturedPayloadState;
  readonly requestJson?: string;
  readonly requestByteLength?: number;
  readonly responseState: CapturedPayloadState;
  readonly responseJson?: string;
  readonly responseByteLength?: number;
}

export class LlmContextInspectorService {
  private capture: PersistedCapturePreference = { version: 1, enabled: false, captureEpoch: 0 };
  private readonly capturePreferenceLane = new KeyedOperationLane<'capture'>();
  private forceCaptureEnabled = false;

  constructor(
    private readonly store: LlmContextInspectorHistoryStore,
    private readonly db: AppDb,
    private readonly buildVariant: InspectorBuildVariant,
    private readonly nowMs: () => number,
  ) {}

  async initialize(forceCaptureEnabled = false): Promise<void> {
    this.requireAvailable();
    this.forceCaptureEnabled = forceCaptureEnabled;
    if (this.forceCaptureEnabled) return;
    try {
      this.capture = decodeCapturePreference(readPreferenceValue(this.db, CAPTURE_PREFERENCE_KEY));
    } catch {
      this.capture = { version: 1, enabled: false, captureEpoch: 0 };
    }
  }

  get available(): boolean {
    return this.buildVariant !== 'unavailable';
  }

  getCaptureEnabled(): boolean {
    this.requireAvailable();
    return this.forceCaptureEnabled || this.capture.enabled;
  }

  captureState(): { readonly enabled: boolean; readonly epoch: number } {
    return {
      enabled: this.available && (this.forceCaptureEnabled || this.capture.enabled),
      epoch: this.capture.captureEpoch,
    };
  }

  async setCaptureEnabled(enabled: boolean): Promise<boolean> {
    this.requireAvailable();
    if (this.forceCaptureEnabled) return true;
    return this.capturePreferenceLane.run('capture', async () => {
      if (enabled === this.capture.enabled) return this.capture.enabled;
      const next: PersistedCapturePreference = {
        version: 1,
        enabled,
        captureEpoch: this.capture.captureEpoch + 1,
      };
      upsertPreferenceValue(this.db, CAPTURE_PREFERENCE_KEY, next);
      this.capture = next;
      return enabled;
    });
  }

  listSessions(): Promise<readonly InspectorSessionSummary[]> {
    this.requireAvailable();
    return this.store.listSessions();
  }

  async readOverview(sessionId: string, knownRevision?: string): Promise<OverviewResult> {
    this.requireAvailable();
    const revision = await this.store.readRevision(sessionId);
    if (knownRevision !== undefined && knownRevision === revision) {
      return { revision, unchanged: true };
    }
    const snapshot = await this.store.readOverviewSnapshot(sessionId);
    return {
      revision,
      unchanged: false,
      overview: {
        turns: await this.withPrefixComparisons(snapshot.overview.turns, snapshot.readRequestJson),
      },
    };
  }

  async readCall(sessionId: string, callId: string): Promise<CallDetailResult> {
    this.requireAvailable();
    const detail = await this.store.readCall(sessionId, callId);
    if (!detail) {
      throw new LlmContextInspectorServiceError(
        404,
        'LLM_CONTEXT_CALL_NOT_FOUND',
        `call ${callId} was not captured`,
      );
    }
    return {
      callId,
      requestState: detail.request.state,
      ...(detail.request.json === undefined ? {} : { requestJson: detail.request.json }),
      ...(detail.request.byteLength === undefined
        ? {}
        : { requestByteLength: detail.request.byteLength }),
      responseState: detail.response.state,
      ...(detail.response.json === undefined ? {} : { responseJson: detail.response.json }),
      ...(detail.response.byteLength === undefined
        ? {}
        : { responseByteLength: detail.response.byteLength }),
    };
  }

  deleteTurns(sessionId: string, turnIds: readonly string[]): Promise<void> {
    this.requireAvailable();
    return this.store.deleteTurns(sessionId, turnIds);
  }

  clearSessionHistory(sessionId: string): Promise<void> {
    this.requireAvailable();
    return this.store.clearSession(sessionId);
  }

  async recordCompletedCompaction(sessionId: string, attemptId: string): Promise<void> {
    const capture = this.captureState();
    if (!capture.enabled) return;
    await this.store.recordCompletedCompaction({
      sessionId,
      attemptId,
      completedAtMs: this.nowMs(),
      captureEpoch: capture.epoch,
    });
  }

  private async withPrefixComparisons(
    turns: readonly StoredTurnSummary[],
    readRequestJson: (callId: string) => Promise<string | undefined>,
  ): Promise<readonly InspectorTurnSummary[]> {
    let baseline: StoredCallSummary | undefined;
    let baselineRequestJson: string | undefined;
    const projected: InspectorTurnSummary[] = [];
    for (const turn of turns) {
      const calls: InspectorCallSummary[] = [];
      for (const call of turn.calls) {
        const currentRequestJson = await readRequestJson(call.callId);
        const prefixComparison = compareContextPrefix(
          {
            callId: call.callId,
            providerId: call.providerId,
            modelId: call.modelId,
            apiId: call.apiId,
            captureEpoch: call.captureEpoch,
            ...(currentRequestJson === undefined ? {} : { requestJson: currentRequestJson }),
          },
          baseline
            ? {
                callId: baseline.callId,
                providerId: baseline.providerId,
                modelId: baseline.modelId,
                apiId: baseline.apiId,
                captureEpoch: baseline.captureEpoch,
                ...(baselineRequestJson === undefined ? {} : { requestJson: baselineRequestJson }),
              }
            : undefined,
        );
        calls.push({ ...call, prefixComparison });
        baseline = call;
        baselineRequestJson = currentRequestJson;
      }
      projected.push({ ...turn, calls });
    }
    return projected;
  }

  private requireAvailable(): void {
    if (this.available) return;
    throw new LlmContextInspectorServiceError(
      503,
      'LLM_CONTEXT_INSPECTOR_UNAVAILABLE',
      'the LLM Context Inspector is not available in this build',
    );
  }
}

function decodeCapturePreference(value: unknown): PersistedCapturePreference {
  if (
    value !== null &&
    typeof value === 'object' &&
    Reflect.get(value, 'version') === 1 &&
    typeof Reflect.get(value, 'enabled') === 'boolean' &&
    typeof Reflect.get(value, 'captureEpoch') === 'number' &&
    Number.isSafeInteger(Reflect.get(value, 'captureEpoch')) &&
    Number(Reflect.get(value, 'captureEpoch')) >= 0
  ) {
    return {
      version: 1,
      enabled: Reflect.get(value, 'enabled') as boolean,
      captureEpoch: Number(Reflect.get(value, 'captureEpoch')),
    };
  }
  return { version: 1, enabled: false, captureEpoch: 0 };
}
