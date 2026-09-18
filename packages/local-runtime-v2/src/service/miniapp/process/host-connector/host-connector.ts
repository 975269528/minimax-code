import { randomUUID } from 'node:crypto';

import {
  ConnectorGatewayError,
  type HostProcessConnectorGateway,
  type ConnectorToolHandle,
} from '../../../host-connector-system/index.js';
import type {
  MiniAppHostConnectorReadable,
  MiniAppHostConnectorSession,
  MiniAppHostConnectorSessionFactory,
  MiniAppHostConnectorWritable,
} from '../../contracts.js';
import {
  encodeFrame,
  HostConnectorProtocolError,
  StrictNdjsonDecoder,
  writeBytes,
} from './host-connector-ndjson.js';
import {
  createHostConnectorGatewayRelease,
  HostConnectorSessionLifecycle,
} from './host-connector-quiesce.js';
import {
  HostConnectorCancelledError,
  type HostConnectorDiagnostic,
  type HostConnectorDiagnosticIssue,
  type HostConnectorDisposition,
  HostConnectorError,
  HostConnectorRequestTimeoutError,
  type HostConnectorWireError as WireError,
  isSafeHostConnectorDiagnosticConstraint,
  isSafeHostConnectorDiagnosticPath,
  normalizeGatewayError,
  providerWireError,
  serviceRestartedWireError,
  staleToolWireError,
  unavailableWireError,
} from './host-connector-errors.js';

const REQUEST_MAX_BYTES = 256 * 1024;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_PENDING = 16;

type JsonPrimitive = null | boolean | number | string;
type HostConnectorJson =
  | JsonPrimitive
  | { readonly [key: string]: HostConnectorJson }
  | readonly HostConnectorJson[];
type HostConnectorJsonObject = { readonly [key: string]: HostConnectorJson };
type HostConnectorListedTool = Awaited<ReturnType<HostConnectorClient['list']>>['tools'][number];

declare const HOST_CONNECTOR_TOOL_REF: unique symbol;
type HostConnectorToolRef = string & {
  readonly [HOST_CONNECTOR_TOOL_REF]: true;
};

export interface HostConnectorClient {
  list(options?: { readonly signal?: AbortSignal }): Promise<{
    readonly tools: readonly {
      readonly toolRef: HostConnectorToolRef;
      readonly provider: string;
      readonly name: string;
      readonly description?: string;
      readonly inputSchema: HostConnectorJson;
      readonly outputSchema?: HostConnectorJson;
    }[];
    readonly partial: boolean;
  }>;
  call(
    toolRef: HostConnectorToolRef,
    arguments_: HostConnectorJsonObject,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly invocationId: string; readonly value: HostConnectorJson }>;
}

interface RequestFrame {
  readonly id: string;
  readonly method: 'connector.list' | 'connector.call' | 'connector.cancel';
  readonly params?: Record<string, unknown>;
}

interface PendingChildRequest {
  readonly method: 'connector.list' | 'connector.call';
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  written: boolean;
  invocationId?: string;
  abortCleanup?: () => void;
}

export interface MiniAppHostConnectorRuntimeClient {
  readonly client: HostConnectorClient;
  close(): void;
}

/** Child-side implementation injected into `start(context)`. */
export function createMiniAppHostConnectorRuntimeClient(options: {
  readonly input: MiniAppHostConnectorReadable;
  readonly output: MiniAppHostConnectorWritable;
  readonly onFatal?: (error: Error) => void;
}): MiniAppHostConnectorRuntimeClient {
  const pending = new Map<string, PendingChildRequest>();
  let nextRequestId = 1n;
  let closed = false;
  let writeTail = Promise.resolve();

  const decoder = new StrictNdjsonDecoder(RESPONSE_MAX_BYTES, (value) => {
    try {
      handleResponse(value);
    } catch (error) {
      fatal(error);
    }
  });
  const onData = (chunk: unknown) => {
    try {
      decoder.push(chunk as Buffer | string);
    } catch (error) {
      fatal(error);
    }
  };
  const onEnd = () => {
    try {
      decoder.end();
    } catch (error) {
      fatal(error);
      return;
    }
    fatal(new HostConnectorProtocolError('Host Connector response ended'));
  };
  const onError = () => fatal(new HostConnectorProtocolError('Host Connector response failed'));
  options.input.on('data', onData);
  options.input.on('end', onEnd);
  options.input.on('error', onError);

  function detach(): void {
    options.input.removeListener('data', onData);
    options.input.removeListener('end', onEnd);
    options.input.removeListener('error', onError);
  }

  function fatal(error: unknown): void {
    if (closed) return;
    closed = true;
    const normalized =
      error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed');
    for (const [id, entry] of pending) {
      entry.abortCleanup?.();
      entry.reject(disconnectedError(id, entry));
    }
    pending.clear();
    detach();
    options.onFatal?.(normalized);
  }

  function handleResponse(value: unknown): void {
    if (!isRecord(value) || value.v !== 1 || !isRequestId(value.id)) {
      throw new HostConnectorProtocolError('Host Connector response envelope is invalid');
    }
    const entry = pending.get(value.id);
    if (!entry) throw new HostConnectorProtocolError('Host Connector response id is unknown');
    if (value.receipt === 'admitted') {
      recordAdmissionReceipt(value, entry);
      return;
    }
    const success = value.ok === true;
    const keys = success ? ['v', 'id', 'ok', 'result'] : ['v', 'id', 'ok', 'error'];
    if (!hasExactKeys(value, keys)) {
      throw new HostConnectorProtocolError('Host Connector response shape is invalid');
    }
    if (success) {
      const result = decodeChildResult(entry.method, value.result);
      assertInvocationIdentity(entry, result);
      settle(value.id, entry, undefined, result);
      return;
    }
    const decoded = decodeWireError(value.error);
    assertInvocationIdentity(entry, decoded);
    settle(value.id, entry, decoded);
  }

  function settle(id: string, entry: PendingChildRequest, error?: Error, result?: unknown): void {
    pending.delete(id);
    entry.abortCleanup?.();
    if (error) entry.reject(error);
    else entry.resolve(result);
  }

  function send(
    method: PendingChildRequest['method'],
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (closed) return Promise.reject(unavailableError());
    if (signal?.aborted) return Promise.reject(cancelledError());
    if (pending.size >= MAX_PENDING) return Promise.reject(unavailableError(true));
    const id = allocateRequestId();
    let frame: Buffer;
    try {
      frame = encodeFrame({ v: 1, id, method, params }, REQUEST_MAX_BYTES);
    } catch {
      return Promise.reject(
        method === 'connector.call'
          ? invalidArgumentsError()
          : new HostConnectorProtocolError('Host Connector list request is invalid'),
      );
    }
    return new Promise((resolve, reject) => {
      const entry: PendingChildRequest = { method, resolve, reject, written: false };
      pending.set(id, entry);
      const onAbort = () => {
        if (!entry.written) {
          settle(id, entry, cancelledError());
          return;
        }
        enqueueWrite(async () => {
          if (pending.has(id)) {
            await writeBytes(
              options.output,
              encodeFrame({ v: 1, id, method: 'connector.cancel' }, REQUEST_MAX_BYTES),
            );
          }
        });
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        entry.abortCleanup = () => signal.removeEventListener('abort', onAbort);
      }
      enqueueWrite(async () => {
        if (!pending.has(id)) return;
        await writeBytes(options.output, frame, () => {
          entry.written = true;
        });
        if (signal?.aborted) onAbort();
      });
    });
  }

  function enqueueWrite(operation: () => Promise<void>): void {
    writeTail = runChildWrite(writeTail, operation, fatal);
  }

  function allocateRequestId(): string {
    if (nextRequestId > 18_446_744_073_709_551_615n) {
      throw new HostConnectorProtocolError('Host Connector request ids exhausted');
    }
    const value = nextRequestId.toString();
    nextRequestId += 1n;
    return value;
  }

  const client: HostConnectorClient = Object.freeze({
    async list(callOptions?: Parameters<HostConnectorClient['list']>[0]) {
      return (await send('connector.list', {}, callOptions?.signal)) as Awaited<
        ReturnType<HostConnectorClient['list']>
      >;
    },
    async call(
      toolRef: HostConnectorToolRef,
      arguments_: HostConnectorJsonObject,
      callOptions?: Parameters<HostConnectorClient['call']>[2],
    ) {
      if (!isBoundedIdentifier(toolRef) || !isRecord(arguments_)) {
        throw invalidArgumentsError();
      }
      return (await send(
        'connector.call',
        { toolRef, arguments: arguments_ },
        callOptions?.signal,
      )) as Awaited<ReturnType<HostConnectorClient['call']>>;
    },
  });

  return {
    client,
    close() {
      fatal(new HostConnectorProtocolError('Host Connector client closed'));
    },
  };
}

async function runChildWrite(
  previous: Promise<void>,
  operation: () => Promise<void>,
  fatal: (error: unknown) => void,
): Promise<void> {
  try {
    await previous;
    await operation();
  } catch (error) {
    fatal(error);
  }
}

interface ActiveHostRequest {
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  execution?: Promise<void>;
  dispatched: boolean;
}

interface RegisteredActiveHostRequest extends ActiveHostRequest {
  readonly complete: () => void;
}

function markHostRequestDispatched(requests: Map<string, ActiveHostRequest>, id: string): void {
  const request = requests.get(id);
  if (request) request.dispatched = true;
}

function dispatchedRequestCompletions(
  requests: ReadonlyMap<string, ActiveHostRequest>,
): readonly Promise<void>[] {
  return [...requests.values()]
    .filter((request) => request.dispatched)
    .map((request) => request.completion);
}

function requestCompletions(
  requests: ReadonlyMap<string, ActiveHostRequest>,
): readonly Promise<void>[] {
  return [...requests.values()].map((request) => request.completion);
}

function registerActiveHostRequest(
  requests: Map<string, ActiveHostRequest>,
  id: string,
  controller: AbortController,
): RegisteredActiveHostRequest {
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const request: RegisteredActiveHostRequest = {
    controller,
    completion,
    dispatched: false,
    complete: () => {
      requests.delete(id);
      resolveCompletion();
    },
  };
  requests.set(id, request);
  return request;
}

interface HostSessionFactoryOptions {
  readonly gateway: HostProcessConnectorGateway;
  readonly makeToolRef?: () => string;
  readonly makeInvocationId?: () => string;
  readonly graceTimeoutMs?: number;
  readonly settleTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
}

/** Host-side generation-bound session backed only by the ConnectorGateway seam. */
export function createMiniAppHostConnectorSessionFactory(
  options: HostSessionFactoryOptions,
): MiniAppHostConnectorSessionFactory {
  return {
    create(input) {
      options.gateway.registerHostProcess({
        pluginId: input.pluginId,
        processGeneration: input.processGeneration,
      });
      return createHostConnectorSession(options, input);
    },
  };
}

function createHostConnectorSession(
  options: HostSessionFactoryOptions,
  input: Parameters<MiniAppHostConnectorSessionFactory['create']>[0],
): MiniAppHostConnectorSession {
  const requests = new Map<string, ActiveHostRequest>();
  let highestRequestId = 0n;
  let refs = new Map<string, ConnectorToolHandle>();
  let refsByHandle = new Map<ConnectorToolHandle, string>();
  const lifecycle = new HostConnectorSessionLifecycle();
  let handshakeStarted = false;
  let fatalReported = false;
  let publishResponses = true;
  let writeTail = Promise.resolve();
  let retirePromise: Promise<void> | undefined;
  const releaseGateway = createHostConnectorGatewayRelease(options.gateway, input);
  const makeToolRef = options.makeToolRef ?? randomUUID;
  const makeInvocationId = options.makeInvocationId ?? randomUUID;
  const timeouts = hostSessionTimeouts(options);
  const decoder = new StrictNdjsonDecoder(REQUEST_MAX_BYTES, (value) => {
    try {
      handleFrame(value);
    } catch (error) {
      fail(error);
    }
  });
  const detach = bindHostRequestDecoder({
    request: input.request,
    decoder,
    handshakeStarted: () => handshakeStarted,
    fail,
  });
  function handleFrame(value: unknown): void {
    const frame = decodeRequest(value);
    if (frame.method === 'connector.cancel') {
      const request = requests.get(frame.id);
      if (request) {
        request.controller.abort(new HostConnectorCancelledError('Request cancelled'));
      } else if (BigInt(frame.id) > highestRequestId) {
        throw new HostConnectorProtocolError('Host Connector cancel id is unknown');
      }
      return;
    }
    const numericId = BigInt(frame.id);
    if (numericId <= highestRequestId || requests.size >= MAX_PENDING) {
      throw new HostConnectorProtocolError('Host Connector request ordering is invalid');
    }
    highestRequestId = numericId;
    const controller = new AbortController();
    const request = registerActiveHostRequest(requests, frame.id, controller);
    request.execution = runTimedHostRequest({
      frame,
      controller,
      timeoutMs: timeouts.requestMs,
      dispatch,
      fail,
      complete: request.complete,
    });
  }

  async function dispatch(frame: RequestFrame, signal: AbortSignal): Promise<void> {
    const gate = lifecycle.gate();
    if (gate !== 'open') {
      await respondError(
        frame.id,
        gate === 'service-restarted' ? serviceRestartedWireError() : unavailableWireError(),
      );
      return;
    }
    if (frame.method === 'connector.list') {
      if (!frame.params || !hasExactKeys(frame.params, [])) throw protocolParamsError();
      await list(frame.id, signal);
      return;
    }
    const callParams = decodeCallParams(frame.params);
    if (!lifecycle.isActive()) {
      await respondError(frame.id, unavailableWireError());
      return;
    }
    await call(frame.id, callParams.toolRef, callParams.arguments, signal);
  }

  async function list(id: string, signal: AbortSignal): Promise<void> {
    try {
      const inventory = await listHostConnectorTools({
        gateway: options.gateway,
        pluginId: input.pluginId,
        processGeneration: input.processGeneration,
        providers: input.providers,
        signal,
        makeToolRef,
        previousRefs: refsByHandle,
        markDispatched: () => markHostRequestDispatched(requests, id),
      });
      refs = inventory.refs;
      refsByHandle = inventory.refsByHandle;
      await respond(id, { tools: inventory.tools, partial: inventory.partial });
    } catch (error) {
      await respondError(id, normalizeGatewayError(error));
    }
  }

  async function call(
    id: string,
    toolRef: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await dispatchHostConnectorCall({
      id,
      toolRef,
      arguments: arguments_,
      signal,
      refs,
      gateway: options.gateway,
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
      makeInvocationId,
      admissionGate: () => lifecycle.gate(),
      markDispatched: () => markHostRequestDispatched(requests, id),
      enqueueResponse,
      respond,
      respondError,
    });
  }

  const respond = (id: string, result: unknown) => enqueueResponse({ v: 1, id, ok: true, result });
  const respondError = (id: string, error: WireError) =>
    enqueueResponse({ v: 1, id, ok: false, error });

  function enqueueResponse(value: unknown): Promise<void> {
    const operation = writeHostResponse(
      writeTail,
      () => publishResponses && !lifecycle.isRetired() && !input.response.destroyed,
      input.response,
      value,
    );
    writeTail = ignoreFailure(operation);
    return operation;
  }

  async function retire(): Promise<void> {
    if (!lifecycle.beginRetirement()) return;
    const pending = requestCompletions(requests);
    if (!(await settleWithin(Promise.allSettled(pending), timeouts.graceMs))) {
      publishResponses = false;
      for (const request of requests.values()) request.controller.abort();
    }
    await settleWithin(
      Promise.allSettled([...requestCompletions(requests), writeTail]),
      timeouts.settleMs,
    );
    lifecycle.markRetired();
    refs.clear();
    refsByHandle.clear();
    detach();
    releaseGateway();
  }

  function fail(error: unknown): void {
    if (fatalReported || lifecycle.isRetired()) return;
    fatalReported = true;
    lifecycle.beginRetirement();
    publishResponses = false;
    refs.clear();
    refsByHandle.clear();
    for (const request of requests.values()) request.controller.abort();
    detach();
    releaseGateway();
    retirePromise ??= retire();
    input.onFatal(
      error instanceof Error ? error : new HostConnectorProtocolError('Host Connector failed'),
    );
  }

  return {
    startHandshake() {
      if (!lifecycle.isRetired()) handshakeStarted = true;
    },
    activate: () => lifecycle.activate(),
    beginQuiesce(quiesceInput) {
      return lifecycle.beginQuiesce({
        pending: dispatchedRequestCompletions(requests),
        deadlineMs: quiesceInput.deadlineMs,
        signal: quiesceInput.signal,
        commit: () => {
          refs.clear();
          refsByHandle.clear();
          releaseGateway();
        },
      });
    },
    retire() {
      retirePromise ??= retire();
      return retirePromise;
    },
    close() {
      publishResponses = false;
      for (const request of requests.values()) request.controller.abort();
      refs.clear();
      refsByHandle.clear();
      detach();
      releaseGateway();
      retirePromise ??= retire();
      return retirePromise;
    },
  };
}

async function dispatchHostConnectorCall(input: {
  readonly id: string;
  readonly toolRef: string;
  readonly arguments: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly refs: ReadonlyMap<string, ConnectorToolHandle>;
  readonly gateway: HostProcessConnectorGateway;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly makeInvocationId: () => string;
  readonly admissionGate: () => 'open' | 'unavailable' | 'service-restarted';
  readonly markDispatched: () => void;
  readonly enqueueResponse: (value: unknown) => Promise<void>;
  readonly respond: (id: string, result: unknown) => Promise<void>;
  readonly respondError: (id: string, error: WireError) => Promise<void>;
}): Promise<void> {
  const handle = input.refs.get(input.toolRef);
  if (!handle) {
    await input.respondError(input.id, staleToolWireError());
    return;
  }
  let invocationId: string | undefined;
  let gatewayPromiseObtained = false;
  try {
    invocationId = requireInvocationId(input.makeInvocationId());
    await input.enqueueResponse({ v: 1, id: input.id, receipt: 'admitted', invocationId });
    const gate = input.admissionGate();
    if (gate !== 'open') {
      await input.respondError(
        input.id,
        gate === 'service-restarted'
          ? serviceRestartedWireError(invocationId)
          : { ...unavailableWireError(), invocationId },
      );
      return;
    }
    const call = beginHostConnectorToolCall({
      gateway: input.gateway,
      handle,
      arguments: input.arguments,
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
      clientRequestId: input.id,
      invocationId,
      signal: input.signal,
    });
    gatewayPromiseObtained = true;
    input.markDispatched();
    const result = await completeHostConnectorToolCall(call, input.signal, invocationId);
    if (result.isError) {
      await input.respondError(input.id, providerWireError(invocationId));
      return;
    }
    await input.respond(input.id, { invocationId, value: result.value });
  } catch (error) {
    await input.respondError(
      input.id,
      normalizeGatewayError(error, invocationId, gatewayPromiseObtained),
    );
  }
}

function hostSessionTimeouts(options: HostSessionFactoryOptions) {
  return {
    graceMs: Math.max(1, options.graceTimeoutMs ?? 4_000),
    settleMs: Math.max(1, options.settleTimeoutMs ?? 1_000),
    requestMs: Math.max(1, options.requestTimeoutMs ?? 30_000),
  };
}

function bindHostRequestDecoder(input: {
  readonly request: MiniAppHostConnectorReadable;
  readonly decoder: StrictNdjsonDecoder;
  readonly handshakeStarted: () => boolean;
  readonly fail: (error: unknown) => void;
}): () => void {
  const onData = (chunk: unknown) => {
    if (!input.handshakeStarted()) {
      input.fail(new HostConnectorProtocolError('Host Connector output preceded handshake'));
      return;
    }
    try {
      input.decoder.push(chunk as Buffer | string);
    } catch (error) {
      input.fail(error);
    }
  };
  const onEnd = () => {
    try {
      input.decoder.end();
    } catch (error) {
      input.fail(error);
      return;
    }
    input.fail(new HostConnectorProtocolError('Host Connector request ended'));
  };
  const onError = () => input.fail(new HostConnectorProtocolError('Host Connector request failed'));
  return bindRequestStream(input.request, { onData, onEnd, onError });
}

async function runTimedHostRequest(input: {
  readonly frame: RequestFrame;
  readonly controller: AbortController;
  readonly timeoutMs: number;
  readonly dispatch: (frame: RequestFrame, signal: AbortSignal) => Promise<void>;
  readonly fail: (error: unknown) => void;
  readonly complete: () => void;
}): Promise<void> {
  const timer = setTimeout(
    () =>
      input.controller.abort(
        new HostConnectorRequestTimeoutError('Host Connector request timed out'),
      ),
    input.timeoutMs,
  );
  timer.unref();
  try {
    await input.dispatch(input.frame, input.controller.signal);
  } catch (error) {
    input.fail(error);
  } finally {
    clearTimeout(timer);
    input.complete();
  }
}

function bindRequestStream(
  request: MiniAppHostConnectorReadable,
  listeners: {
    readonly onData: (chunk: unknown) => void;
    readonly onEnd: () => void;
    readonly onError: () => void;
  },
): () => void {
  request.on('data', listeners.onData);
  request.on('end', listeners.onEnd);
  request.on('error', listeners.onError);
  return () => {
    request.removeListener('data', listeners.onData);
    request.removeListener('end', listeners.onEnd);
    request.removeListener('error', listeners.onError);
  };
}

async function listHostConnectorTools(input: {
  readonly gateway: HostProcessConnectorGateway;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly providers: readonly string[];
  readonly signal: AbortSignal;
  readonly makeToolRef: () => string;
  readonly previousRefs: ReadonlyMap<ConnectorToolHandle, string>;
  readonly markDispatched: () => void;
}) {
  const operation = input.gateway.list({
    providerAllowlist: input.providers,
    caller: {
      kind: 'host-process',
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
    },
    signal: input.signal,
  });
  input.markDispatched();
  const inventory = await raceWithSignal(operation, input.signal);
  const refs = new Map<string, ConnectorToolHandle>();
  const refsByHandle = new Map<ConnectorToolHandle, string>();
  const tools: HostConnectorListedTool[] = [];
  let partial = inventory.partial;
  for (const tool of inventory.tools) {
    try {
      tools.push(
        decodeInventoryTool({
          tool,
          refs,
          refsByHandle,
          previousRefs: input.previousRefs,
          makeToolRef: input.makeToolRef,
        }),
      );
    } catch (error) {
      if (!(error instanceof HostConnectorProtocolError)) throw error;
      partial = true;
    }
  }
  return { tools, refs, refsByHandle, partial };
}

function decodeInventoryTool(input: {
  readonly tool: Awaited<ReturnType<HostProcessConnectorGateway['list']>>['tools'][number];
  readonly refs: Map<string, ConnectorToolHandle>;
  readonly refsByHandle: Map<ConnectorToolHandle, string>;
  readonly previousRefs: ReadonlyMap<ConnectorToolHandle, string>;
  readonly makeToolRef: () => string;
}): HostConnectorListedTool {
  const { tool } = input;
  const inputSchema = parseJson(tool.inputSchemaJson, RESPONSE_MAX_BYTES);
  const outputSchema = tool.outputSchemaJson
    ? parseJson(tool.outputSchemaJson, RESPONSE_MAX_BYTES)
    : undefined;
  const previousRef = input.previousRefs.get(tool.handle);
  const toolRef = previousRef ?? mintToolRef(tool.handle, input.refs, input.makeToolRef);
  if (previousRef && input.refs.has(toolRef)) {
    throw new HostConnectorProtocolError('Host Connector tool reference collided');
  }
  if (previousRef) input.refs.set(toolRef, tool.handle);
  input.refsByHandle.set(tool.handle, toolRef);
  return {
    toolRef: toolRef as HostConnectorToolRef,
    provider: tool.provider,
    name: tool.providerToolName,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

function beginHostConnectorToolCall(input: {
  readonly gateway: HostProcessConnectorGateway;
  readonly handle: ConnectorToolHandle;
  readonly arguments: Record<string, unknown>;
  readonly pluginId: string;
  readonly processGeneration: string;
  readonly clientRequestId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}): ReturnType<HostProcessConnectorGateway['call']> {
  return input.gateway.call({
    handle: input.handle,
    arguments: input.arguments,
    caller: {
      kind: 'host-process',
      pluginId: input.pluginId,
      processGeneration: input.processGeneration,
    },
    hostRequest: {
      clientRequestId: input.clientRequestId,
      invocationId: input.invocationId,
    },
    signal: input.signal,
  });
}

async function completeHostConnectorToolCall(
  operation: ReturnType<HostProcessConnectorGateway['call']>,
  signal: AbortSignal,
  invocationId: string,
) {
  const result = await raceWithSignal(operation, signal);
  let value: HostConnectorJson;
  try {
    value = result.isError ? null : parseJson(result.resultJson ?? 'null', RESPONSE_MAX_BYTES);
  } catch {
    throw new ConnectorGatewayError(
      'CONNECTOR_RESULT_INVALID',
      'Connector result was invalid after dispatch',
      'unknown_after_dispatch',
      invocationId,
    );
  }
  return {
    isError: result.isError,
    value,
  };
}

function mintToolRef(
  handle: ConnectorToolHandle,
  target: Map<string, ConnectorToolHandle>,
  makeToolRef: () => string,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const ref = makeToolRef();
    if (isBoundedIdentifier(ref) && !target.has(ref)) {
      target.set(ref, handle);
      return ref;
    }
  }
  throw new HostConnectorProtocolError('Host Connector could not mint a tool ref');
}

async function writeHostResponse(
  previous: Promise<void>,
  shouldPublish: () => boolean,
  output: MiniAppHostConnectorWritable,
  value: unknown,
): Promise<void> {
  await previous;
  if (!shouldPublish()) return;
  await writeBytes(output, encodeFrame(value, RESPONSE_MAX_BYTES));
}

async function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  let rejectOnAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = () => rejectOnAbort(signal.reason);
  try {
    signal.addEventListener('abort', onAbort, { once: true });
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function ignoreFailure(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The owning state machine reports or intentionally suppresses transport failure.
  }
}

function decodeCallParams(params: Record<string, unknown> | undefined): {
  readonly toolRef: string;
  readonly arguments: Record<string, unknown>;
} {
  if (
    !params ||
    !hasExactKeys(params, ['toolRef', 'arguments']) ||
    !isBoundedIdentifier(params.toolRef) ||
    !isRecord(params.arguments)
  ) {
    throw protocolParamsError();
  }
  return { toolRef: params.toolRef, arguments: params.arguments };
}

function decodeRequest(value: unknown): RequestFrame {
  if (!isRecord(value) || value.v !== 1 || !isRequestId(value.id)) throw protocolParamsError();
  if (value.method === 'connector.cancel' && hasExactKeys(value, ['v', 'id', 'method'])) {
    return { id: value.id, method: value.method };
  }
  if (
    (value.method !== 'connector.list' && value.method !== 'connector.call') ||
    !hasExactKeys(value, ['v', 'id', 'method', 'params']) ||
    !isRecord(value.params)
  ) {
    throw protocolParamsError();
  }
  return { id: value.id, method: value.method, params: value.params };
}

function decodeChildResult(method: PendingChildRequest['method'], value: unknown): unknown {
  if (!isRecord(value)) throw new HostConnectorProtocolError('Host Connector result is invalid');
  if (method === 'connector.list') {
    if (
      !hasExactKeys(value, ['tools', 'partial']) ||
      !Array.isArray(value.tools) ||
      typeof value.partial !== 'boolean'
    ) {
      throw new HostConnectorProtocolError('Host Connector inventory is invalid');
    }
    return value;
  }
  if (!hasExactKeys(value, ['invocationId', 'value']) || !isBoundedIdentifier(value.invocationId)) {
    throw new HostConnectorProtocolError('Host Connector call result is invalid');
  }
  return value;
}

function decodeWireError(value: unknown): HostConnectorError {
  if (!isWireErrorEnvelope(value)) {
    throw new HostConnectorProtocolError('Host Connector error is invalid');
  }
  const diagnostic = 'diagnostic' in value ? decodeWireDiagnostic(value.diagnostic) : undefined;
  if ((value.code === 'INVALID_ARGUMENTS' || diagnostic) && !isInvalidArgumentsWireError(value)) {
    throw new HostConnectorProtocolError('Host Connector error is invalid');
  }
  return new HostConnectorError(
    value.code,
    value.message,
    value.disposition as HostConnectorDisposition,
    {
      retryable: value.retryable,
      ...(typeof value.invocationId === 'string' ? { invocationId: value.invocationId } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    },
  );
}

function isWireErrorEnvelope(value: unknown): value is Record<string, unknown> & WireError {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      'code',
      'message',
      'disposition',
      'retryable',
      ...('invocationId' in value ? ['invocationId'] : []),
      ...('diagnostic' in value ? ['diagnostic'] : []),
    ]) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    isHostConnectorDisposition(value.disposition) &&
    typeof value.retryable === 'boolean' &&
    (!('invocationId' in value) || isBoundedIdentifier(value.invocationId))
  );
}

function isHostConnectorDisposition(value: unknown): value is HostConnectorDisposition {
  return ['not_dispatched', 'provider_reported', 'unknown_after_dispatch'].includes(String(value));
}

function isInvalidArgumentsWireError(value: WireError): boolean {
  return (
    value.code === 'INVALID_ARGUMENTS' &&
    value.message === 'Connector arguments are invalid' &&
    value.disposition === 'not_dispatched' &&
    !value.retryable
  );
}

function decodeWireDiagnostic(value: unknown): HostConnectorDiagnostic {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['issues']) ||
    !Array.isArray(value.issues) ||
    value.issues.length === 0 ||
    value.issues.length > 4
  ) {
    throw new HostConnectorProtocolError('Host Connector error diagnostic is invalid');
  }
  return { issues: value.issues.map(decodeWireDiagnosticIssue) };
}

function decodeWireDiagnosticIssue(value: unknown): HostConnectorDiagnosticIssue {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'constraint', ...('limit' in value ? ['limit'] : [])]) ||
    !isSafeHostConnectorDiagnosticPath(value.path) ||
    !isSafeHostConnectorDiagnosticConstraint(value.constraint) ||
    ('limit' in value && (typeof value.limit !== 'number' || !Number.isFinite(value.limit)))
  ) {
    throw new HostConnectorProtocolError('Host Connector error diagnostic is invalid');
  }
  return {
    path: value.path,
    constraint: value.constraint,
    ...('limit' in value ? { limit: value.limit as number } : {}),
  };
}

function recordAdmissionReceipt(value: Record<string, unknown>, entry: PendingChildRequest): void {
  if (
    entry.method !== 'connector.call' ||
    entry.invocationId ||
    !hasExactKeys(value, ['v', 'id', 'receipt', 'invocationId']) ||
    !isBoundedIdentifier(value.invocationId)
  ) {
    throw new HostConnectorProtocolError('Host Connector admission receipt is invalid');
  }
  entry.invocationId = value.invocationId;
}

function assertInvocationIdentity(entry: PendingChildRequest, value: unknown): void {
  if (entry.method !== 'connector.call') return;
  let actual: string | undefined;
  if (value instanceof HostConnectorError) actual = value.invocationId;
  else if (isRecord(value) && typeof value.invocationId === 'string') {
    actual = value.invocationId;
  }
  if (entry.invocationId === actual) return;
  throw new HostConnectorProtocolError('Host Connector invocation identity is invalid');
}

function parseJson(json: string, maxBytes: number): HostConnectorJson {
  if (Buffer.byteLength(json) > maxBytes) {
    throw new HostConnectorProtocolError('Host Connector payload exceeds its frame limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new HostConnectorProtocolError('Host Connector payload is not valid JSON');
  }
  return value as HostConnectorJson;
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    resolvesTrue(operation),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

async function resolvesTrue(operation: Promise<unknown>): Promise<true> {
  await operation;
  return true;
}

function disconnectedError(id: string, request: PendingChildRequest): HostConnectorError {
  return request.method === 'connector.call' && request.written
    ? new HostConnectorError(
        'CONNECTOR_OUTCOME_UNKNOWN',
        'Host Connector transport ended after dispatch became possible',
        'unknown_after_dispatch',
        { retryable: false, invocationId: request.invocationId ?? id },
      )
    : unavailableError(true);
}

function unavailableError(retryable = false): HostConnectorError {
  return new HostConnectorError(
    'CONNECTOR_UNAVAILABLE',
    'Host Connector is unavailable',
    'not_dispatched',
    { retryable },
  );
}

function cancelledError(): HostConnectorError {
  return new HostConnectorError(
    'REQUEST_CANCELLED',
    'Host Connector request was cancelled',
    'not_dispatched',
    { retryable: false },
  );
}

function invalidArgumentsError(): HostConnectorError {
  return new HostConnectorError(
    'INVALID_ARGUMENTS',
    'Host Connector arguments must fit one JSON frame',
    'not_dispatched',
    { retryable: false },
  );
}

function protocolParamsError(): HostConnectorProtocolError {
  return new HostConnectorProtocolError('Host Connector request is invalid');
}

function requireInvocationId(value: unknown): string {
  if (!isBoundedIdentifier(value)) {
    throw new HostConnectorProtocolError('Host Connector invocation id is invalid');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES
  );
}

function isRequestId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/u.test(value)) return false;
  try {
    return BigInt(value) <= 18_446_744_073_709_551_615n;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
