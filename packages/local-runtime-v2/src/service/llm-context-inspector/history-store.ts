import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';

import {
  appendJsonl,
  publishFileIfAbsent,
  publishJsonlIfAbsent,
  readJsonl,
  replaceFileAtomically,
} from '../../infra/file/jsonl.js';
import { resolveSessionHistoryPaths } from '../session-system/messages/index.js';
import type {
  CapturedPayload,
  CapturedPayloadState,
  ExpectedToolIdentity,
  InspectorSessionIdentity,
  InspectorSessionSource,
  InspectorSessionSummary,
  SettledCallRecord,
  StoredCallDetail,
  StoredCallSummary,
  StoredOverview,
  StoredTurnSummary,
} from './contracts.js';

const INSPECTOR_DIRECTORY = 'llm-context-inspector';
const EVENT_FILE = 'events.jsonl';
const PAYLOAD_DIRECTORY = 'payloads';
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const SESSION_INDEX_DIRECTORY = join('v2', INSPECTOR_DIRECTORY, 'sessions');

interface SessionDiscoveredRecord {
  readonly v: 1;
  readonly type: 'session.discovered';
  readonly sessionId: string;
  readonly source: InspectorSessionSource;
}

interface CallCapturedEvent {
  readonly v: 1;
  readonly type: 'call.captured';
  readonly callId: string;
  readonly turnId: string;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly apiId: string;
  readonly attemptCount: number;
  readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly expectedTools: readonly ExpectedToolIdentity[];
  readonly requestState: CapturedPayloadState;
  readonly requestByteLength?: number;
  readonly responseState: CapturedPayloadState;
  readonly responseByteLength?: number;
  readonly captureEpoch: number;
}

interface CompactionCompletedEvent {
  readonly v: 1;
  readonly type: 'compaction.completed';
  readonly attemptId: string;
  readonly completedAtMs: number;
  readonly captureEpoch: number;
}

interface ToolExecutionStartedEvent {
  readonly v: 1;
  readonly type: 'tool.execution_started';
  readonly callId: string;
  readonly toolCallId: string;
  readonly startedAtMs: number;
}

interface ToolExecutionCompletedEvent {
  readonly v: 1;
  readonly type: 'tool.execution_completed';
  readonly callId: string;
  readonly toolCallId: string;
  readonly endedAtMs: number;
  readonly isError: boolean;
}

type InspectorEvent =
  | CallCapturedEvent
  | CompactionCompletedEvent
  | ToolExecutionStartedEvent
  | ToolExecutionCompletedEvent;

export interface LlmContextInspectorHistoryStoreOptions {
  readonly dataDir: string;
  readonly resolveSession: (sessionId: string) => Promise<InspectorSessionIdentity | undefined>;
  readonly runtimeOwnerKind: InspectorSessionSource;
}

export interface InspectorOverviewSnapshot {
  readonly overview: StoredOverview;
  readRequestJson(callId: string): Promise<string | undefined>;
}

/** Session-owned, append-only Inspector history. */
export class LlmContextInspectorHistoryStore {
  private readonly lane = new KeyedOperationLane<string>();
  private readonly mutationIdentities = new Map<string, MutationIdentities>();

  constructor(private readonly options: LlmContextInspectorHistoryStoreOptions) {}

  persistSettledCall(record: SettledCallRecord): Promise<void> {
    return this.lane.run(record.sessionId, async () => {
      const paths = await this.paths(record.sessionId);
      if (!paths) return;
      const identities = await this.loadMutationIdentities(record.sessionId, paths.events);
      if (identities.callIds.has(record.callId)) return;

      const request = boundedPayload(record.request);
      const response = boundedPayload(record.response);
      await publishPayload(paths.payloads, record.callId, 'request', request);
      await publishPayload(paths.payloads, record.callId, 'response', response);
      await this.publishSessionIndex(record.sessionId);
      await appendJsonl(paths.events, [toCallEvent(record, request, response)]);
      identities.callIds.add(record.callId);
    });
  }

  async listSessions(): Promise<readonly InspectorSessionSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(this.sessionIndexDirectory());
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return [];
      throw error;
    }

    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.jsonl'))
        .map(async (entry): Promise<InspectorSessionSummary | undefined> => {
          try {
            const records = await readJsonl(
              join(this.sessionIndexDirectory(), entry),
              decodeSessionDiscoveredRecord,
            );
            const discovered = records[0];
            if (!discovered || records.length !== 1) return undefined;
            const session = await this.options.resolveSession(discovered.sessionId);
            if (!session || session.sessionId !== discovered.sessionId) return undefined;
            const paths = await this.paths(discovered.sessionId);
            if (!paths) return undefined;
            const eventInfo = await stat(paths.events);
            if (eventInfo.size === 0) return undefined;
            return {
              ...session,
              updatedAtMs: Math.trunc(eventInfo.mtimeMs),
              source: discovered.source,
            };
          } catch {
            return undefined;
          }
        }),
    );
    return sessions
      .filter((session): session is InspectorSessionSummary => session !== undefined)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  }

  recordToolStarted(input: {
    readonly sessionId: string;
    readonly callId: string;
    readonly toolCallId: string;
    readonly startedAtMs: number;
  }): Promise<void> {
    return this.lane.run(input.sessionId, async () => {
      const paths = await this.paths(input.sessionId);
      if (!paths) return;
      await appendJsonl(paths.events, [
        {
          v: 1,
          type: 'tool.execution_started',
          callId: input.callId,
          toolCallId: input.toolCallId,
          startedAtMs: input.startedAtMs,
        } satisfies ToolExecutionStartedEvent,
      ]);
    });
  }

  recordToolCompleted(input: {
    readonly sessionId: string;
    readonly callId: string;
    readonly toolCallId: string;
    readonly endedAtMs: number;
    readonly isError: boolean;
  }): Promise<void> {
    return this.lane.run(input.sessionId, async () => {
      const paths = await this.paths(input.sessionId);
      if (!paths) return;
      await appendJsonl(paths.events, [
        {
          v: 1,
          type: 'tool.execution_completed',
          callId: input.callId,
          toolCallId: input.toolCallId,
          endedAtMs: input.endedAtMs,
          isError: input.isError,
        } satisfies ToolExecutionCompletedEvent,
      ]);
    });
  }

  recordCompletedCompaction(input: {
    readonly sessionId: string;
    readonly attemptId: string;
    readonly completedAtMs: number;
    readonly captureEpoch: number;
  }): Promise<void> {
    return this.lane.run(input.sessionId, async () => {
      const paths = await this.paths(input.sessionId);
      if (!paths) return;
      const identities = await this.loadMutationIdentities(input.sessionId, paths.events);
      if (identities.compactionAttemptIds.has(input.attemptId)) return;
      await appendJsonl(paths.events, [
        {
          v: 1,
          type: 'compaction.completed',
          attemptId: input.attemptId,
          completedAtMs: input.completedAtMs,
          captureEpoch: input.captureEpoch,
        } satisfies CompactionCompletedEvent,
      ]);
      identities.compactionAttemptIds.add(input.attemptId);
    });
  }

  readRevision(sessionId: string): Promise<string> {
    return this.lane.run(sessionId, async () => {
      const paths = await this.paths(sessionId);
      if (!paths) return '0';
      try {
        const info = await stat(paths.events, { bigint: true });
        return `${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}`;
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return '0';
        throw error;
      }
    });
  }

  async readOverview(sessionId: string): Promise<StoredOverview> {
    const snapshot = await this.readOverviewSnapshot(sessionId);
    return snapshot.overview;
  }

  readOverviewSnapshot(sessionId: string): Promise<InspectorOverviewSnapshot> {
    return this.lane.run(sessionId, async () => {
      const paths = await this.paths(sessionId);
      if (!paths) {
        return { overview: { turns: [] }, readRequestJson: async () => undefined };
      }
      const events = await readEvents(paths.events);
      const captured = events.filter(
        (event): event is CallCapturedEvent => event.type === 'call.captured',
      );
      const byCallId = new Map(captured.map((event) => [event.callId, event]));
      return {
        overview: projectOverview(events),
        readRequestJson: async (callId) => {
          const event = byCallId.get(callId);
          if (!event) return undefined;
          const payload = await readPayload({
            payloadDirectory: paths.payloads,
            callId,
            side: 'request',
            state: event.requestState,
            byteLength: event.requestByteLength,
          });
          return payload.state === 'AVAILABLE' ? payload.json : undefined;
        },
      };
    });
  }

  readCall(sessionId: string, callId: string): Promise<StoredCallDetail | undefined> {
    return this.lane.run(sessionId, async () => {
      const paths = await this.paths(sessionId);
      if (!paths) return undefined;
      const event = (await readEvents(paths.events)).find(
        (candidate): candidate is CallCapturedEvent =>
          candidate.type === 'call.captured' && candidate.callId === callId,
      );
      if (!event) return undefined;
      return {
        callId,
        providerId: event.providerId,
        modelId: event.modelId,
        apiId: event.apiId,
        request: await readPayload({
          payloadDirectory: paths.payloads,
          callId,
          side: 'request',
          state: event.requestState,
          byteLength: event.requestByteLength,
        }),
        response: await readPayload({
          payloadDirectory: paths.payloads,
          callId,
          side: 'response',
          state: event.responseState,
          byteLength: event.responseByteLength,
        }),
      };
    });
  }

  deleteTurns(sessionId: string, turnIds: readonly string[]): Promise<void> {
    if (turnIds.length === 0) return Promise.resolve();
    const deletedTurnIds = new Set(turnIds);
    return this.lane.run(sessionId, async () => {
      const paths = await this.paths(sessionId);
      if (!paths) return;
      const events = await readEvents(paths.events);
      const deletedCallIds = new Set(
        events.flatMap((event) =>
          event.type === 'call.captured' && deletedTurnIds.has(event.turnId) ? [event.callId] : [],
        ),
      );
      if (deletedCallIds.size === 0) return;
      const retainedEvents = events.filter(
        (event) =>
          !(
            (event.type === 'call.captured' && deletedCallIds.has(event.callId)) ||
            ((event.type === 'tool.execution_started' ||
              event.type === 'tool.execution_completed') &&
              deletedCallIds.has(event.callId))
          ),
      );
      if (retainedEvents.length === 0) {
        await rm(paths.events, { force: true });
      } else {
        await replaceFileAtomically(
          paths.events,
          `${retainedEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
          async (temporaryPath) => {
            await readJsonl(temporaryPath, decodeEvent);
          },
        );
      }
      await Promise.all(
        [...deletedCallIds].flatMap((callId) => [
          rm(payloadPath(paths.payloads, callId, 'request'), { force: true }),
          rm(payloadPath(paths.payloads, callId, 'response'), { force: true }),
        ]),
      );
      this.mutationIdentities.delete(sessionId);
    });
  }

  clearSession(sessionId: string): Promise<void> {
    return this.lane.run(sessionId, async () => {
      const paths = await this.paths(sessionId);
      this.mutationIdentities.delete(sessionId);
      if (!paths) return;
      await rm(paths.directory, { recursive: true, force: true });
      await rm(this.sessionIndexPath(sessionId), { force: true });
    });
  }

  private async publishSessionIndex(sessionId: string): Promise<void> {
    await publishJsonlIfAbsent(this.sessionIndexPath(sessionId), [
      {
        v: 1,
        type: 'session.discovered',
        sessionId,
        source: this.options.runtimeOwnerKind,
      } satisfies SessionDiscoveredRecord,
    ]);
  }

  private sessionIndexDirectory(): string {
    return join(this.options.dataDir, SESSION_INDEX_DIRECTORY);
  }

  private sessionIndexPath(sessionId: string): string {
    return join(
      this.sessionIndexDirectory(),
      `${Buffer.from(sessionId, 'utf8').toString('base64url')}.jsonl`,
    );
  }

  private async loadMutationIdentities(
    sessionId: string,
    eventPath: string,
  ): Promise<MutationIdentities> {
    const cached = this.mutationIdentities.get(sessionId);
    if (cached) return cached;

    const identities: MutationIdentities = {
      callIds: new Set<string>(),
      compactionAttemptIds: new Set<string>(),
    };
    for (const event of await readEvents(eventPath)) {
      if (event.type === 'call.captured') identities.callIds.add(event.callId);
      else if (event.type === 'compaction.completed') {
        identities.compactionAttemptIds.add(event.attemptId);
      }
    }
    this.mutationIdentities.set(sessionId, identities);
    return identities;
  }

  private async paths(sessionId: string): Promise<InspectorPaths | undefined> {
    const session = await this.options.resolveSession(sessionId);
    if (!session || session.sessionId !== sessionId) return undefined;
    const sessionDirectory = resolveSessionHistoryPaths(this.options.dataDir, session).sessionDir;
    const directory = join(sessionDirectory, INSPECTOR_DIRECTORY);
    return {
      directory,
      events: join(directory, EVENT_FILE),
      payloads: join(directory, PAYLOAD_DIRECTORY),
    };
  }
}

interface InspectorPaths {
  readonly directory: string;
  readonly events: string;
  readonly payloads: string;
}

interface MutationIdentities {
  readonly callIds: Set<string>;
  readonly compactionAttemptIds: Set<string>;
}

function toCallEvent(
  record: SettledCallRecord,
  request: CapturedPayload,
  response: CapturedPayload,
): CallCapturedEvent {
  return {
    v: 1,
    type: 'call.captured',
    callId: record.callId,
    turnId: record.turnId,
    startedAtMs: record.startedAtMs,
    durationMs: record.durationMs,
    providerId: record.providerId,
    modelId: record.modelId,
    apiId: record.apiId,
    attemptCount: record.attemptCount,
    ...(record.usage ? { usage: record.usage } : {}),
    expectedTools: record.expectedTools,
    requestState: request.state,
    ...(request.byteLength === undefined ? {} : { requestByteLength: request.byteLength }),
    responseState: response.state,
    ...(response.byteLength === undefined ? {} : { responseByteLength: response.byteLength }),
    captureEpoch: record.captureEpoch,
  };
}

function boundedPayload(payload: CapturedPayload): CapturedPayload {
  if (payload.state !== 'AVAILABLE' || payload.json === undefined) return payload;
  const byteLength = Buffer.byteLength(payload.json, 'utf8');
  return byteLength > MAX_PAYLOAD_BYTES
    ? { state: 'OMITTED_TOO_LARGE', byteLength }
    : { state: 'AVAILABLE', json: payload.json, byteLength };
}

async function publishPayload(
  payloadDirectory: string,
  callId: string,
  side: 'request' | 'response',
  payload: CapturedPayload,
): Promise<void> {
  if (payload.state !== 'AVAILABLE' || payload.json === undefined) return;
  await publishFileIfAbsent(payloadPath(payloadDirectory, callId, side), payload.json);
}

interface ReadPayloadInput {
  readonly payloadDirectory: string;
  readonly callId: string;
  readonly side: 'request' | 'response';
  readonly state: CapturedPayloadState;
  readonly byteLength: number | undefined;
}

async function readPayload(input: ReadPayloadInput): Promise<CapturedPayload> {
  const { payloadDirectory, callId, side, state, byteLength } = input;
  if (state !== 'AVAILABLE') {
    return { state, ...(byteLength === undefined ? {} : { byteLength }) };
  }
  try {
    const json = await readFile(payloadPath(payloadDirectory, callId, side), 'utf8');
    return {
      state: 'AVAILABLE',
      json,
      byteLength: byteLength ?? Buffer.byteLength(json, 'utf8'),
    };
  } catch {
    return { state: 'CAPTURE_FAILED', ...(byteLength === undefined ? {} : { byteLength }) };
  }
}

function payloadPath(
  payloadDirectory: string,
  callId: string,
  side: 'request' | 'response',
): string {
  return join(
    payloadDirectory,
    `${Buffer.from(callId, 'utf8').toString('base64url')}.${side}.json`,
  );
}

function projectOverview(events: readonly InspectorEvent[]): StoredOverview {
  const turns = new Map<string, StoredTurnSummary & { calls: StoredCallSummary[] }>();
  const callsById = new Map<string, StoredCallSummary>();
  let pendingCompactionEpoch: number | undefined;
  for (const event of events) {
    if (event.type === 'compaction.completed') {
      pendingCompactionEpoch = event.captureEpoch;
      continue;
    }
    if (event.type === 'tool.execution_started' || event.type === 'tool.execution_completed') {
      projectToolEvent(callsById.get(event.callId), event);
      continue;
    }
    let turn = turns.get(event.turnId);
    if (!turn) {
      turn = { turnId: event.turnId, turnOrdinal: turns.size + 1, calls: [] };
      turns.set(event.turnId, turn);
    }
    const call: StoredCallSummary = {
      callId: event.callId,
      callOrdinal: turn.calls.length + 1,
      startedAtMs: event.startedAtMs,
      durationMs: event.durationMs,
      providerId: event.providerId,
      modelId: event.modelId,
      apiId: event.apiId,
      attemptCount: event.attemptCount,
      ...(event.usage ? { usage: event.usage } : {}),
      tools: event.expectedTools.map((tool) => ({ ...tool })),
      hasCompactionBefore: pendingCompactionEpoch === event.captureEpoch,
      captureEpoch: event.captureEpoch,
    };
    turn.calls.push(call);
    callsById.set(event.callId, call);
    pendingCompactionEpoch = undefined;
  }
  return { turns: [...turns.values()] };
}

function projectToolEvent(
  call: StoredCallSummary | undefined,
  event: ToolExecutionStartedEvent | ToolExecutionCompletedEvent,
): void {
  if (!call) return;
  const matches = call.tools.filter((tool) => tool.toolCallId === event.toolCallId);
  if (matches.length !== 1) return;
  const tool = matches[0] as {
    startedAtMs?: number;
    durationMs?: number;
    isError?: boolean;
  };
  if (event.type === 'tool.execution_started') {
    if (tool.startedAtMs === undefined) tool.startedAtMs = event.startedAtMs;
    return;
  }
  if (
    tool.startedAtMs === undefined ||
    tool.durationMs !== undefined ||
    event.endedAtMs < tool.startedAtMs
  ) {
    return;
  }
  tool.durationMs = event.endedAtMs - tool.startedAtMs;
  tool.isError = event.isError;
}

async function readEvents(path: string): Promise<InspectorEvent[]> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  }
  try {
    return await readJsonl(path, decodeEvent);
  } catch (error) {
    if (contents.endsWith('\n')) throw error;
    const lastBoundary = contents.lastIndexOf('\n');
    const tail = contents.slice(lastBoundary + 1);
    try {
      JSON.parse(tail);
      throw error;
    } catch (tailError) {
      if (tailError === error || !(tailError instanceof SyntaxError)) throw tailError;
    }
    const committedPrefix = lastBoundary < 0 ? '' : contents.slice(0, lastBoundary + 1);
    await replaceFileAtomically(path, committedPrefix, async (temporaryPath) => {
      await readJsonl(temporaryPath, decodeEvent);
    });
    return readJsonl(path, decodeEvent);
  }
}

function decodeEvent(value: unknown): InspectorEvent {
  if (!isObject(value) || value.v !== 1 || typeof value.type !== 'string') {
    throw new Error('unsupported Inspector event');
  }
  switch (value.type) {
    case 'compaction.completed':
      return decodeCompactionEvent(value);
    case 'tool.execution_started':
      return decodeToolStartedEvent(value);
    case 'tool.execution_completed':
      return decodeToolCompletedEvent(value);
    case 'call.captured':
      return decodeCallEvent(value);
    default:
      throw new Error('unknown Inspector event');
  }
}

function decodeSessionDiscoveredRecord(value: unknown): SessionDiscoveredRecord {
  if (
    !isObject(value) ||
    value.v !== 1 ||
    value.type !== 'session.discovered' ||
    (value.source !== 'electron' && value.source !== 'tui')
  ) {
    throw new Error('unsupported Inspector Session index');
  }
  return {
    v: 1,
    type: 'session.discovered',
    sessionId: requiredString(value.sessionId),
    source: value.source,
  };
}

function decodeCompactionEvent(value: Record<string, unknown>): CompactionCompletedEvent {
  return {
    v: 1,
    type: 'compaction.completed',
    attemptId: requiredString(value.attemptId),
    completedAtMs: finiteNumber(value.completedAtMs),
    captureEpoch: finiteNumber(value.captureEpoch),
  };
}

function decodeToolStartedEvent(value: Record<string, unknown>): ToolExecutionStartedEvent {
  return {
    v: 1,
    type: 'tool.execution_started',
    callId: requiredString(value.callId),
    toolCallId: requiredString(value.toolCallId),
    startedAtMs: finiteNumber(value.startedAtMs),
  };
}

function decodeToolCompletedEvent(value: Record<string, unknown>): ToolExecutionCompletedEvent {
  return {
    v: 1,
    type: 'tool.execution_completed',
    callId: requiredString(value.callId),
    toolCallId: requiredString(value.toolCallId),
    endedAtMs: finiteNumber(value.endedAtMs),
    isError: requiredBoolean(value.isError),
  };
}

function decodeCallEvent(value: Record<string, unknown>): CallCapturedEvent {
  return {
    v: 1,
    type: 'call.captured',
    callId: requiredString(value.callId),
    turnId: requiredString(value.turnId),
    startedAtMs: finiteNumber(value.startedAtMs),
    durationMs: finiteNumber(value.durationMs),
    providerId: requiredString(value.providerId),
    modelId: requiredString(value.modelId),
    apiId: requiredString(value.apiId),
    attemptCount: finiteNumber(value.attemptCount),
    ...(isUsage(value.usage) ? { usage: value.usage } : {}),
    expectedTools: decodeExpectedTools(value.expectedTools),
    requestState: payloadState(value.requestState),
    ...(typeof value.requestByteLength === 'number'
      ? { requestByteLength: finiteNumber(value.requestByteLength) }
      : {}),
    responseState: payloadState(value.responseState),
    ...(typeof value.responseByteLength === 'number'
      ? { responseByteLength: finiteNumber(value.responseByteLength) }
      : {}),
    captureEpoch: finiteNumber(value.captureEpoch),
  };
}

function decodeExpectedTools(value: unknown): readonly ExpectedToolIdentity[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('invalid expected tools');
  return value.map((tool) => {
    if (!isObject(tool)) throw new Error('invalid expected tool');
    return {
      toolCallId: requiredString(tool.toolCallId),
      toolName: requiredString(tool.toolName),
    };
  });
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('expected string');
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('expected number');
  return value;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('expected boolean');
  return value;
}

function payloadState(value: unknown): CapturedPayloadState {
  if (value === 'AVAILABLE' || value === 'OMITTED_TOO_LARGE' || value === 'CAPTURE_FAILED') {
    return value;
  }
  throw new Error('invalid payload state');
}

function isUsage(value: unknown): value is CallCapturedEvent['usage'] {
  return (
    isObject(value) &&
    ['input', 'output', 'cacheRead', 'cacheWrite'].every(
      (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
    )
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isObject(error) && error.code === code;
}
