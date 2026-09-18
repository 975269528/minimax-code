export const SESSION_TURN_REPLAY_MAX_FRAMES = 5_000;
export const SESSION_TURN_REPLAY_MAX_BYTES = 8 * 1024 * 1024;

export type SessionTurnStreamFrame =
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'data'; readonly data: string; readonly cursor?: string }
  | { readonly kind: 'resume-overflow' }
  | { readonly kind: 'done' };

export interface SessionTurnStreamFrameInput {
  readonly data: string;
  readonly messageId?: string;
  readonly chunkIndex?: number;
  readonly completeMessage?: boolean;
}

export type ActiveResumeAnchor =
  | {
      readonly kind: 'cursor';
      readonly afterCursor: string;
    }
  | {
      readonly kind: 'message';
      readonly afterMessageId: string;
      readonly existsInHistory: boolean;
    };

export interface SessionTurnReplayLimits {
  readonly maxFrames: number;
  readonly maxBytes: number;
}

interface RetainedFrame {
  readonly data: string;
  readonly cursor: string;
  readonly bytes: number;
  readonly messageId?: string;
  readonly chunkIndex?: number;
  readonly completeMessage: boolean;
}

interface Subscriber {
  readonly queued: SessionTurnStreamFrame[];
  readonly waiting: Array<(result: IteratorResult<SessionTurnStreamFrame>) => void>;
  readonly replayedMessageIds: Set<string>;
  readonly chunkCursors: Map<string, number>;
  readonly subscriberKey?: string;
  closed: boolean;
}

export class SessionTurnStream {
  private readonly encoder = new TextEncoder();
  private readonly frames: RetainedFrame[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private nextSequence = 0;
  private retainedBytes = 0;
  private replayEvicted = false;
  private completed = false;

  constructor(
    private readonly turnId: string,
    private readonly limits: Readonly<SessionTurnReplayLimits> = {
      maxFrames: SESSION_TURN_REPLAY_MAX_FRAMES,
      maxBytes: SESSION_TURN_REPLAY_MAX_BYTES,
    },
  ) {}

  write(input: SessionTurnStreamFrameInput): void {
    if (this.completed) return;
    const frame: RetainedFrame = {
      data: input.data,
      cursor: `${this.turnId}:${this.nextSequence}`,
      bytes: this.encoder.encode(input.data).byteLength,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.chunkIndex === undefined ? {} : { chunkIndex: input.chunkIndex }),
      completeMessage: input.completeMessage === true,
    };
    this.nextSequence += 1;
    this.frames.push(frame);
    this.retainedBytes += frame.bytes;
    this.pruneReplay();
    for (const subscriber of this.subscribers) {
      this.pushData(subscriber, frame);
    }
  }

  open(
    anchor?: ActiveResumeAnchor,
    options: { readonly subscriberKey?: string } = {},
  ): AsyncIterable<SessionTurnStreamFrame> {
    const subscriber: Subscriber = {
      queued: [{ kind: 'heartbeat' }],
      waiting: [],
      replayedMessageIds: new Set(anchor?.kind === 'message' ? [anchor.afterMessageId] : undefined),
      chunkCursors: new Map(),
      ...(options.subscriberKey ? { subscriberKey: options.subscriberKey } : {}),
      closed: false,
    };
    const replay = this.replayAfter(anchor);
    if (replay === undefined) {
      subscriber.queued.push({ kind: 'resume-overflow' });
    } else {
      for (const frame of replay) this.pushData(subscriber, frame);
    }
    if (this.completed) {
      subscriber.queued.push({ kind: 'done' });
      subscriber.closed = true;
    } else {
      this.takeOverRawSubscribers(options.subscriberKey);
      this.subscribers.add(subscriber);
    }
    return this.iterable(subscriber);
  }

  checkpoint(): { rollback(): void } {
    const baseline = new Set(this.frames);
    return {
      rollback: () => {
        const retained = this.frames.filter((frame) => baseline.has(frame));
        this.frames.splice(0, this.frames.length, ...retained);
        this.retainedBytes = retained.reduce((total, frame) => total + frame.bytes, 0);
      },
    };
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    for (const subscriber of this.subscribers) {
      this.push(subscriber, { kind: 'done' });
      subscriber.closed = true;
    }
    this.subscribers.clear();
  }

  private pruneReplay(): void {
    while (
      this.frames.length > this.limits.maxFrames ||
      this.retainedBytes > this.limits.maxBytes
    ) {
      const frame = this.frames.shift();
      if (!frame) return;
      this.retainedBytes -= frame.bytes;
      this.replayEvicted = true;
    }
  }

  private replayAfter(anchor: ActiveResumeAnchor | undefined): RetainedFrame[] | undefined {
    if (!anchor) return [...this.frames];
    if (anchor.kind === 'cursor') {
      const index = this.frames.findIndex((frame) => frame.cursor === anchor.afterCursor);
      return index < 0 ? undefined : this.frames.slice(index + 1);
    }
    if (this.replayEvicted) return undefined;
    const index = this.frames.findIndex((frame) => frame.messageId === anchor.afterMessageId);
    if (index >= 0) return this.frames.slice(index + 1);
    return anchor.existsInHistory ? [...this.frames] : undefined;
  }

  private publicFrame(frame: RetainedFrame): SessionTurnStreamFrame {
    return { kind: 'data', data: frame.data, cursor: frame.cursor };
  }

  private push(subscriber: Subscriber, frame: SessionTurnStreamFrame): void {
    const resolve = subscriber.waiting.shift();
    if (resolve) {
      resolve({ done: false, value: frame });
      return;
    }
    subscriber.queued.push(frame);
  }

  private pushData(subscriber: Subscriber, frame: RetainedFrame): void {
    if (
      frame.completeMessage &&
      frame.messageId &&
      subscriber.replayedMessageIds.has(frame.messageId)
    ) {
      return;
    }
    if (!frame.completeMessage && frame.messageId) {
      const replayedChunk = subscriber.chunkCursors.get(frame.messageId);
      if (replayedChunk !== undefined) {
        if ((frame.chunkIndex ?? -1) <= replayedChunk) return;
        subscriber.chunkCursors.delete(frame.messageId);
      }
    }
    this.push(subscriber, this.publicFrame(frame));
    if (frame.completeMessage && frame.messageId) {
      subscriber.replayedMessageIds.add(frame.messageId);
    } else if (frame.messageId && frame.chunkIndex !== undefined) {
      const previous = subscriber.chunkCursors.get(frame.messageId) ?? -1;
      if (frame.chunkIndex > previous)
        subscriber.chunkCursors.set(frame.messageId, frame.chunkIndex);
    }
  }

  private takeOverRawSubscribers(subscriberKey: string | undefined): void {
    if (!subscriberKey) return;
    for (const subscriber of this.subscribers) {
      if (!subscriber.subscriberKey || subscriber.subscriberKey === subscriberKey) continue;
      this.push(subscriber, { kind: 'done' });
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
    }
  }

  private iterable(subscriber: Subscriber): AsyncIterable<SessionTurnStreamFrame> {
    const close = (): IteratorResult<SessionTurnStreamFrame> => {
      subscriber.closed = true;
      this.subscribers.delete(subscriber);
      for (const resolve of subscriber.waiting.splice(0)) {
        resolve({ done: true, value: undefined });
      }
      return { done: true, value: undefined };
    };
    const iterator: AsyncIterableIterator<SessionTurnStreamFrame> = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => {
        const frame = subscriber.queued.shift();
        if (frame) return Promise.resolve({ done: false as const, value: frame });
        if (subscriber.closed) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise((resolve) => subscriber.waiting.push(resolve));
      },
      return: async () => close(),
    };
    return iterator;
  }
}
