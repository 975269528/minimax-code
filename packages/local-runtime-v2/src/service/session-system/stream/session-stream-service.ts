import {
  BoundedRing,
  SubscriberRegistry,
  measureValue,
  type BoundedRingOptions,
  type RingEntry,
  type StreamSubscription,
  type SubscriberRegistryOptions,
} from '../../../infra/sse/index.js';
import type { DisplayMessageRecord, MessageReplayResult } from '../messages/index.js';
import type {
  SessionFrame,
  SessionFrameInput,
  SessionFrameWriteResult,
  SessionStreamWriter,
} from './session-frame.js';
import {
  SessionFrameRetention,
  sessionRingOptions,
  type RetainedSessionFrame,
  type UnsequencedSessionFrame,
} from './session-frame-retention.js';

export interface SessionMessageReplaySource {
  listAfter(sessionId: string, afterMsgId?: string): Promise<MessageReplayResult>;
}

export interface SessionStreamServiceOptions {
  readonly messages: SessionMessageReplaySource;
  readonly ring?: BoundedRingOptions;
  readonly subscribers?: SubscriberRegistryOptions;
  readonly nowMs?: () => number;
}

export interface ResumeSessionInput {
  readonly sessionId: string;
  readonly afterMsgId?: string;
  readonly afterCursor?: string;
  /**
   * false only replays an anchored captured tail; true waits for the first
   * terminal observed after the resume boundary. An unanchored resume is
   * always live-only. Defaults to true for internal callers.
   */
  readonly waitForTerminal?: boolean;
}

export interface SessionStreamReservation {
  readonly source: AsyncIterableIterator<SessionFrame>;
  bindTurn(turnId: string): void;
  complete(): void;
  close(): void;
  discardIfEmpty(): void;
}

interface SessionStreamState {
  readonly ring: BoundedRing<RetainedSessionFrame>;
  readonly subscribers: SubscriberRegistry<SessionFrame>;
  readonly retention: SessionFrameRetention;
  readonly measure: (value: unknown) => number;
  hasFrames: boolean;
  reservationCount: number;
  deleted: boolean;
}

type SessionRingEntry = RingEntry<RetainedSessionFrame>;
type SessionResyncReason = 'evicted' | 'invalid-cursor' | 'missing-message-anchor';

interface StitchDurableReplayInput {
  readonly sessionId: string;
  readonly initial: readonly SessionRingEntry[];
  readonly catchup: readonly SessionRingEntry[];
  readonly durable: readonly DisplayMessageRecord[];
  readonly nowMs: () => number;
}

export class SessionStreamService implements SessionStreamWriter {
  private readonly states = new Map<string, SessionStreamState>();
  private readonly nowMs: () => number;

  constructor(private readonly options: SessionStreamServiceOptions) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  write(input: SessionFrameInput): SessionFrameWriteResult {
    const state = this.state(input.sessionId);
    const value: UnsequencedSessionFrame = {
      identity: input.identity,
      sessionId: input.sessionId,
      kind: input.kind,
      data: input.data,
      createdAtMs: input.createdAtMs ?? this.nowMs(),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.messageActionDeltas ? { messageActionDeltas: input.messageActionDeltas } : {}),
    };
    const retained = state.retention.classify(value);
    const appended = state.ring.append({
      identity: input.identity,
      value: retained,
      byteSize: state.measure(value),
    });
    state.hasFrames = true;
    const frame: SessionFrame = { ...appended.value.frame, cursor: appended.cursor };
    if (appended.appended) state.subscribers.publish(frame, appended.byteSize);
    return { appended: appended.appended, retained: appended.retained, frame };
  }

  reserve(sessionId: string): SessionStreamReservation {
    const state = this.state(sessionId);
    const subscription = state.subscribers.subscribe();
    state.reservationCount += 1;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      subscription.close();
      state.reservationCount -= 1;
    };
    const complete = () => {
      if (closed) return;
      closed = true;
      subscription.complete();
      state.reservationCount -= 1;
    };
    return {
      source: subscription,
      bindTurn: (turnId) => subscription.setFilter((frame) => frame.turnId === turnId),
      complete,
      close,
      discardIfEmpty: () => {
        close();
        if (
          !state.hasFrames &&
          state.reservationCount === 0 &&
          this.states.get(sessionId) === state
        ) {
          this.states.delete(sessionId);
        }
      },
    };
  }

  resume(input: ResumeSessionInput): AsyncIterableIterator<SessionFrame> {
    return new SessionResumeIterator(
      this.state(input.sessionId),
      input,
      this.options.messages,
      this.nowMs,
    );
  }

  deleteSession(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state) return;
    state.deleted = true;
    state.subscribers.close();
    this.states.delete(sessionId);
  }

  dispose(): void {
    this.states.forEach((state) => {
      state.deleted = true;
      state.subscribers.close();
    });
    this.states.clear();
  }

  private state(sessionId: string): SessionStreamState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    const retention = new SessionFrameRetention();
    const created = {
      ring: new BoundedRing<RetainedSessionFrame>(
        {
          ...sessionRingOptions(this.options.ring),
          cursorScope: `session:${sessionId}`,
        },
        (snapshot) => retention.selectEvictionCount(snapshot),
      ),
      subscribers: new SubscriberRegistry<SessionFrame>(this.options.subscribers),
      retention,
      measure: this.options.ring?.measure ?? measureValue,
      hasFrames: false,
      reservationCount: 0,
      deleted: false,
    };
    this.states.set(sessionId, created);
    return created;
  }
}

class SessionResumeIterator implements AsyncIterableIterator<SessionFrame> {
  private readonly live: StreamSubscription<SessionFrame>;
  private readonly initialized: Promise<void>;
  private readonly initializationObserver: Promise<void>;
  private replay: SessionFrame[] = [];
  private closeAfterReplay = false;
  private closed = false;

  constructor(
    private readonly state: SessionStreamState,
    private readonly input: ResumeSessionInput,
    private readonly messages: SessionMessageReplaySource,
    private readonly nowMs: () => number,
  ) {
    this.live = state.subscribers.subscribe();
    this.initialized = this.initialize();
    this.initializationObserver = observeInitialization(this.initialized);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SessionFrame> {
    return this;
  }

  async next(): Promise<IteratorResult<SessionFrame>> {
    if (this.closed || this.state.deleted) {
      this.close();
      return done();
    }
    await this.initialized;
    await this.initializationObserver;
    if (this.closed || this.state.deleted) {
      this.close();
      return done();
    }
    const replayed = this.replay.shift();
    if (replayed) return this.frame(replayed);
    if (this.closeAfterReplay) {
      this.close();
      return done();
    }
    try {
      const result = await this.live.next();
      if (result.done) this.close();
      return result.done ? result : this.frame(result.value);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  return(): Promise<IteratorResult<SessionFrame>> {
    this.close();
    return Promise.resolve(done());
  }

  private async initialize(): Promise<void> {
    const waitForTerminal = this.input.waitForTerminal ?? true;
    if (this.initializeUnanchored(waitForTerminal)) return;
    const initial = this.state.ring.replay(this.input.afterCursor);
    if (initial.status !== 'ok') {
      this.finishWithResync(initial.status);
      return;
    }
    if (hasCursor(this.input.afterCursor)) {
      this.finishCursorReplay(initial.entries, waitForTerminal);
      return;
    }
    await this.initializeDurable(initial.entries, waitForTerminal);
  }

  private async initializeDurable(
    initial: readonly SessionRingEntry[],
    waitForTerminal: boolean,
  ): Promise<void> {
    const initialWatermark = this.state.ring.latestCursor();
    const durable = await this.messages.listAfter(this.input.sessionId, this.input.afterMsgId);
    if (this.closed || this.state.deleted) {
      this.close();
      return;
    }
    if (durable.status === 'missing-anchor') {
      this.finishWithResync('missing-message-anchor');
      return;
    }
    this.finishDurableReplay(initial, initialWatermark, durable);
    if (!waitForTerminal) this.finishIdleReplay();
  }

  private initializeUnanchored(waitForTerminal: boolean): boolean {
    if (hasCursor(this.input.afterCursor) || this.input.afterMsgId) return false;
    if (!waitForTerminal) this.finishIdleReplay();
    return true;
  }

  private finishCursorReplay(entries: readonly SessionRingEntry[], waitForTerminal: boolean): void {
    this.filterLiveAfterReplay(entries);
    this.replay = toFrames(entries);
    if (!waitForTerminal) this.finishIdleReplay();
  }

  private finishDurableReplay(
    initial: readonly SessionRingEntry[],
    initialWatermark: string,
    durable: Extract<MessageReplayResult, { status: 'ok' }>,
  ): void {
    const catchup = this.state.ring.replay(initialWatermark);
    if (catchup.status !== 'ok') {
      this.finishWithResync(catchup.status);
      return;
    }
    const captured = [...initial, ...catchup.entries];
    const replayCatchup = throughFirstTerminal(catchup.entries);
    const replayDurable = withoutMessagesCommittedAfterFirstTerminal(
      catchup.entries,
      durable.messages,
    );
    this.filterLiveAfterReplay(captured);
    this.replay = stitchDurableReplay({
      sessionId: this.input.sessionId,
      initial,
      catchup: replayCatchup,
      durable: replayDurable,
      nowMs: this.nowMs,
    }).filter(
      (frame) =>
        frame.kind !== 'turn-terminal' || this.state.ring.isAfter(frame.cursor, initialWatermark),
    );
  }

  private filterLiveAfterReplay(entries: readonly SessionRingEntry[]): void {
    const replayedCursors = new Set(entries.map(({ cursor }) => cursor));
    this.live.setFilter((frame) => !frame.cursor || !replayedCursors.has(frame.cursor));
  }

  private finishWithResync(reason: SessionResyncReason): void {
    this.replay = [
      resyncFrame(this.input.sessionId, reason, this.state.ring.latestCursor(), this.nowMs()),
    ];
    this.closeAfterReplay = true;
    this.live.close();
  }

  private finishIdleReplay(): void {
    this.closeAfterReplay = true;
    this.live.close();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.replay.length = 0;
    this.live.close();
  }

  private frame(value: SessionFrame): IteratorResult<SessionFrame> {
    if (value.kind === 'turn-terminal') {
      this.replay.length = 0;
      this.closeAfterReplay = true;
      this.live.close();
    }
    return { done: false, value };
  }
}

function durableMessageFrame(
  sessionId: string,
  message: DisplayMessageRecord,
  createdAtMs: number,
  cursor?: string,
): SessionFrame {
  const msgId = typeof message.msg_id === 'string' ? message.msg_id : 'unknown';
  const turnId = message.turnId ?? message.meta?.turnId;
  return {
    identity: `durable:${msgId}`,
    sessionId,
    kind: 'durable-message',
    data: message,
    createdAtMs,
    ...(turnId ? { turnId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function resyncFrame(
  sessionId: string,
  reason: SessionResyncReason,
  latestCursor: string,
  createdAtMs: number,
): SessionFrame {
  return {
    identity: `resync:${reason}:${latestCursor}`,
    sessionId,
    kind: 'resync-required',
    data: { reason },
    cursor: latestCursor,
    createdAtMs,
  };
}

function toFrames(entries: readonly SessionRingEntry[]): SessionFrame[] {
  return entries.map((entry) => ({ ...entry.value.frame, cursor: entry.cursor }));
}

function throughFirstTerminal(entries: readonly SessionRingEntry[]): readonly SessionRingEntry[] {
  const terminalIndex = entries.findIndex(({ value }) => value.frame.kind === 'turn-terminal');
  return terminalIndex < 0 ? entries : entries.slice(0, terminalIndex + 1);
}

function withoutMessagesCommittedAfterFirstTerminal(
  entries: readonly SessionRingEntry[],
  messages: readonly DisplayMessageRecord[],
): readonly DisplayMessageRecord[] {
  const terminalIndex = entries.findIndex(({ value }) => value.frame.kind === 'turn-terminal');
  if (terminalIndex < 0) return messages;
  const excludedMessageIds = new Set(
    entries
      .slice(terminalIndex + 1)
      .filter(({ value }) => value.frame.kind === 'message-committed')
      .flatMap(({ value }) => frameMessages(value.frame))
      .flatMap((message) =>
        typeof message.msg_id === 'string' && message.msg_id.length > 0 ? [message.msg_id] : [],
      ),
  );
  return excludedMessageIds.size === 0
    ? messages
    : messages.filter((message) => !excludedMessageIds.has(message.msg_id ?? ''));
}

function stitchDurableReplay(input: StitchDurableReplayInput): SessionFrame[] {
  const { sessionId, initial, catchup, durable, nowMs } = input;
  const captured = [...initial, ...catchup];
  const lastBoundary = captured.reduce(
    (last, entry, index) => (isDurableBoundary(entry.value.frame) ? index : last),
    -1,
  );
  const replayCursor = lastBoundary < 0 ? undefined : captured[lastBoundary]?.cursor;
  const messages = foldCatchupMessages(catchup, durable);
  const durableFrames = messages.map((message, index) =>
    durableMessageFrame(
      sessionId,
      message,
      nowMs(),
      index === messages.length - 1 ? replayCursor : undefined,
    ),
  );
  return [...durableFrames, ...toFrames(captured.slice(lastBoundary + 1))];
}

function foldCatchupMessages(
  entries: readonly SessionRingEntry[],
  durable: readonly DisplayMessageRecord[],
): DisplayMessageRecord[] {
  return entries
    .filter(({ value }) => isDurableBoundary(value.frame))
    .reduce<DisplayMessageRecord[]>(
      (messages, { value }) => {
        if (value.frame.kind === 'messages-rewound') {
          const removed = new Set(frameRewoundMessageIds(value.frame));
          return messages.filter((message) => !removed.has(message.msg_id ?? ''));
        }
        const changed = frameMessages(value.frame);
        return value.frame.kind === 'messages-replaced'
          ? changed
          : mergeCommittedMessages(messages, changed);
      },
      [...durable],
    );
}

function mergeCommittedMessages(
  messages: readonly DisplayMessageRecord[],
  changed: readonly DisplayMessageRecord[],
): DisplayMessageRecord[] {
  return changed.reduce<DisplayMessageRecord[]>(
    (current, message) => {
      const msgId = typeof message.msg_id === 'string' ? message.msg_id : undefined;
      if (!msgId) return [...current, message];
      const existing = current.findIndex((candidate) => candidate.msg_id === msgId);
      if (existing < 0) return [...current, message];
      return current.map((candidate, index) => (index === existing ? message : candidate));
    },
    [...messages],
  );
}

function isDurableBoundary(frame: UnsequencedSessionFrame): boolean {
  return (
    frame.kind === 'message-committed' ||
    frame.kind === 'messages-replaced' ||
    frame.kind === 'messages-rewound'
  );
}

function frameMessages(frame: UnsequencedSessionFrame): DisplayMessageRecord[] {
  const data = parseRecord(frame.data);
  if (!data) return [];
  const messages = Array.isArray(data['messages']) ? data['messages'] : [];
  return messages
    .filter(isDisplayMessageRecord)
    .map((message) =>
      frame.turnId && !message.turnId && !message.meta?.turnId
        ? { ...message, turnId: frame.turnId }
        : message,
    );
}

function frameRewoundMessageIds(frame: UnsequencedSessionFrame): string[] {
  const data = parseRecord(frame.data);
  const messageIds = Array.isArray(data?.['messageIds']) ? data['messageIds'] : [];
  return messageIds.filter(
    (messageId): messageId is string => typeof messageId === 'string' && messageId.length > 0,
  );
}

function isDisplayMessageRecord(value: unknown): value is DisplayMessageRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasCursor(cursor: string | undefined): cursor is string {
  return cursor !== undefined && cursor.length > 0;
}

function done<T>(): IteratorResult<T> {
  return { done: true, value: undefined };
}

async function observeInitialization(initialized: Promise<void>): Promise<void> {
  try {
    await initialized;
  } catch {
    // `next()` owns error delivery; this observer only prevents an unhandled rejection before read.
  }
}
