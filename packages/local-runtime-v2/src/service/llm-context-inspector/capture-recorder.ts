import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentEvent, StreamFn } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type {
  LLMCallScope,
  LLMCallSettledEvent,
  LlmCaptureAgentEventSource,
  LlmCaptureRecorder,
} from '@mavis/agent-core/pi-turn-runner';

import type { CapturedPayload, ExpectedToolIdentity, SettledCallRecord } from './contracts.js';
import {
  createProviderResponseAssembler,
  type ProviderResponseAssembler,
} from './provider-response-reassembler.js';

const CAPTURED_SCOPE: LLMCallScope = 'agent';
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_READ_BYTES = 64 * 1024 * 1024;

interface ActiveLogicalCall {
  readonly startedAtMs: number;
  readonly captureEpoch: number;
  readonly apiId: string;
  response: ProviderResponseAssembler;
  acceptRequest(payload: CapturedPayload): void;
}

const ACTIVE_LOGICAL_CALL = new AsyncLocalStorage<ActiveLogicalCall>();

export function wrapResolvedFetchForCapture(baseFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const active = ACTIVE_LOGICAL_CALL.getStore();
    if (active) {
      active.response = createProviderResponseAssembler(active.apiId, MAX_PAYLOAD_BYTES);
      active.acceptRequest(readRequestPayload(init?.body));
    }
    return baseFetch(input, init);
  };
}

export interface LlmCaptureRecorderWithFetch extends LlmCaptureRecorder {
  wrapFetch(baseFetch: typeof fetch): typeof fetch;
}

interface LlmCaptureSink {
  persistSettledCall(record: SettledCallRecord): Promise<void>;
  recordToolStarted(input: {
    readonly sessionId: string;
    readonly callId: string;
    readonly toolCallId: string;
    readonly startedAtMs: number;
  }): Promise<void>;
  recordToolCompleted(input: {
    readonly sessionId: string;
    readonly callId: string;
    readonly toolCallId: string;
    readonly endedAtMs: number;
    readonly isError: boolean;
  }): Promise<void>;
}

export interface LlmCaptureRecorderOptions {
  readonly sessionId: string;
  readonly turnId: string;
  readonly sink: LlmCaptureSink;
  readonly captureState: () => { readonly enabled: boolean; readonly epoch: number };
  readonly nowMs: () => number;
}

/** Captures one successful logical Call while discarding every failed attempt. */
export function createLlmCaptureRecorder(
  options: LlmCaptureRecorderOptions,
): LlmCaptureRecorderWithFetch {
  let candidate: LogicalCallCandidate | undefined;
  const persistedCallIds = new Set<string>();
  const pending = new Set<Promise<void>>();
  const toolOwners = new Map<string, ToolOwner | null>();
  let agentEventSource: LlmCaptureAgentEventSource | undefined;
  let unsubscribeAgent: (() => void) | undefined;

  return {
    wrapLogicalStreamFn(inner: StreamFn, settings: { scope: LLMCallScope }): StreamFn {
      if (settings.scope !== CAPTURED_SCOPE) return inner;
      return (async (model, context, streamOptions?: SimpleStreamOptions) => {
        const capture = safeCaptureState(options.captureState);
        if (!capture.enabled) return inner(model, context, streamOptions);
        ensureToolEventSubscription();

        const startedAtMs = options.nowMs();
        const apiId = String(model.api);
        const active: ActiveLogicalCall = {
          startedAtMs,
          captureEpoch: capture.epoch,
          apiId,
          response: createProviderResponseAssembler(apiId, MAX_PAYLOAD_BYTES),
          acceptRequest(request) {
            candidate = {
              startedAtMs,
              captureEpoch: capture.epoch,
              apiId,
              request,
              active,
            };
          },
        };
        candidate = {
          startedAtMs,
          captureEpoch: capture.epoch,
          apiId,
          request: { state: 'CAPTURE_FAILED' },
          active,
        };
        const callerObserver = streamOptions?.onProviderStreamEvent;
        const observedOptions: SimpleStreamOptions = {
          ...(streamOptions ?? {}),
          onProviderStreamEvent: (event, eventModel) => {
            active.response.observe(event);
            callProviderEventObserver(callerObserver, event, eventModel);
          },
        };
        const source = await ACTIVE_LOGICAL_CALL.run(active, () =>
          inner(model, context, observedOptions),
        );
        return withActiveContext(source, active);
      }) as StreamFn;
    },

    wrapFetch(baseFetch: typeof fetch): typeof fetch {
      return wrapResolvedFetchForCapture(baseFetch);
    },

    observeCallSettled(event: LLMCallSettledEvent): void {
      const settled = candidate;
      candidate = undefined;
      if (!shouldPersist(event, settled)) return;
      persistedCallIds.add(event.callId);
      const expectedTools = event.expectedTools ?? [];
      bindExpectedTools(toolOwners, event.callId, expectedTools);
      const persist = persistSettledCallIgnoringFailure(options.sink, {
        sessionId: options.sessionId,
        turnId: options.turnId,
        callId: event.callId,
        providerId: event.provider,
        modelId: event.model,
        apiId: settled.apiId,
        startedAtMs: settled.startedAtMs,
        durationMs: Math.max(0, options.nowMs() - settled.startedAtMs),
        attemptCount: Math.max(1, event.requestAttempts),
        request: settled.request,
        response: settled.active.response.snapshot(),
        ...(event.usage ? { usage: event.usage } : {}),
        expectedTools,
        captureEpoch: settled.captureEpoch,
      });
      pending.add(persist);
    },

    observeAgentEvents(source: LlmCaptureAgentEventSource): void {
      agentEventSource = source;
    },

    async drain(): Promise<void> {
      unsubscribeAgent?.();
      unsubscribeAgent = undefined;
      await Promise.all([...pending]);
    },
  };

  function shouldPersist(
    event: LLMCallSettledEvent,
    settled: LogicalCallCandidate | undefined,
  ): settled is LogicalCallCandidate {
    if (event.scope !== CAPTURED_SCOPE || event.final.outcome !== 'success') return false;
    if (!settled || persistedCallIds.has(event.callId)) return false;
    const current = safeCaptureState(options.captureState);
    return current.enabled && current.epoch === settled.captureEpoch;
  }

  function observeToolEvent(event: AgentEvent): void {
    if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
    const owner = toolOwners.get(event.toolCallId);
    if (!owner || owner.toolName !== event.toolName) return;
    const observedAtMs = options.nowMs();
    if (event.type === 'tool_execution_end') toolOwners.delete(event.toolCallId);
    const persist =
      event.type === 'tool_execution_start'
        ? persistIgnoringFailure(() =>
            options.sink.recordToolStarted({
              sessionId: options.sessionId,
              callId: owner.callId,
              toolCallId: event.toolCallId,
              startedAtMs: observedAtMs,
            }),
          )
        : persistIgnoringFailure(() =>
            options.sink.recordToolCompleted({
              sessionId: options.sessionId,
              callId: owner.callId,
              toolCallId: event.toolCallId,
              endedAtMs: observedAtMs,
              isError: event.isError,
            }),
          );
    pending.add(persist);
  }

  function ensureToolEventSubscription(): void {
    if (unsubscribeAgent || !agentEventSource) return;
    try {
      unsubscribeAgent = agentEventSource.subscribe(observeToolEvent);
    } catch {
      // Capture observation is best-effort and cannot change provider behavior.
    }
  }
}

interface ToolOwner {
  readonly callId: string;
  readonly toolName: string;
}

interface LogicalCallCandidate {
  readonly startedAtMs: number;
  readonly captureEpoch: number;
  readonly apiId: string;
  readonly request: CapturedPayload;
  readonly active: ActiveLogicalCall;
}

function withActiveContext(
  source: AssistantMessageEventStream,
  active: ActiveLogicalCall,
): AssistantMessageEventStream {
  return {
    [Symbol.asyncIterator]() {
      const iterator = ACTIVE_LOGICAL_CALL.run(active, () => source[Symbol.asyncIterator]());
      const wrapped: AsyncIterator<AssistantMessageEvent> = {
        next: (...args) => ACTIVE_LOGICAL_CALL.run(active, () => iterator.next(...args)),
      };
      const returnFromIterator = iterator.return?.bind(iterator);
      if (returnFromIterator) {
        wrapped.return = (...args) =>
          ACTIVE_LOGICAL_CALL.run(active, () => returnFromIterator(...args));
      }
      const throwIntoIterator = iterator.throw?.bind(iterator);
      if (throwIntoIterator) {
        wrapped.throw = (...args) =>
          ACTIVE_LOGICAL_CALL.run(active, () => throwIntoIterator(...args));
      }
      return wrapped;
    },
    result: () => ACTIVE_LOGICAL_CALL.run(active, () => source.result()),
  } as AssistantMessageEventStream;
}

async function persistSettledCallIgnoringFailure(
  sink: LlmCaptureSink,
  record: SettledCallRecord,
): Promise<void> {
  try {
    await sink.persistSettledCall(record);
  } catch {
    // Capture persistence is best-effort and cannot change Call settlement.
  }
}

async function persistIgnoringFailure(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch {
    // Tool timing is best-effort and cannot change Agent behavior.
  }
}

function bindExpectedTools(
  owners: Map<string, ToolOwner | null>,
  callId: string,
  tools: readonly ExpectedToolIdentity[],
): void {
  owners.clear();
  for (const tool of tools) {
    if (owners.has(tool.toolCallId)) {
      owners.set(tool.toolCallId, null);
      continue;
    }
    owners.set(tool.toolCallId, { callId, toolName: tool.toolName });
  }
}

function readRequestPayload(body: RequestInit['body']): CapturedPayload {
  if (typeof body !== 'string') return { state: 'CAPTURE_FAILED' };
  const byteLength = byteLengthOf(body);
  if (byteLength > MAX_REQUEST_READ_BYTES || byteLength > MAX_PAYLOAD_BYTES) {
    return { state: 'OMITTED_TOO_LARGE', byteLength };
  }
  return { state: 'AVAILABLE', json: body, byteLength };
}

function byteLengthOf(value: string): number {
  try {
    return Buffer.byteLength(value, 'utf8');
  } catch {
    return value.length;
  }
}

function safeCaptureState(read: () => { readonly enabled: boolean; readonly epoch: number }): {
  readonly enabled: boolean;
  readonly epoch: number;
} {
  try {
    const state = read();
    return {
      enabled: state.enabled === true,
      epoch: Number.isFinite(state.epoch) ? state.epoch : Number.NaN,
    };
  } catch {
    return { enabled: false, epoch: Number.NaN };
  }
}

function callProviderEventObserver(
  observer: SimpleStreamOptions['onProviderStreamEvent'],
  event: unknown,
  model: Model<Api>,
): void {
  try {
    observer?.(event, model);
  } catch {
    // Capture and caller observation are isolated from provider behavior.
  }
}
