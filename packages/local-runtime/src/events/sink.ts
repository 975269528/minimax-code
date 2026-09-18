import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import type { IRuntimeEvent } from '@mavis/protocol';

import {
  projectLocalRuntimeEvent,
  type LocalRuntimeProjectionFrame,
} from '../runtime/projection.js';

export interface LocalEventSinkSnapshot {
  events: IRuntimeEvent[];
  frames: LocalRuntimeProjectionFrame[];
}

export type LocalEventSubscriber = (
  frame: LocalRuntimeProjectionFrame,
  event: IRuntimeEvent,
) => void | Promise<void>;

export interface LocalEventWriter extends PiEventWriter {
  readonly events: readonly IRuntimeEvent[];
  readonly frames: readonly LocalRuntimeProjectionFrame[];
  subscribe(subscriber: LocalEventSubscriber): () => void;
  snapshot(): LocalEventSinkSnapshot;
}

export class LocalEventSink implements LocalEventWriter {
  private readonly runtimeEvents: IRuntimeEvent[] = [];
  private readonly projectedFrames: LocalRuntimeProjectionFrame[] = [];
  private readonly subscribers = new Set<LocalEventSubscriber>();

  constructor(subscriber?: LocalEventSubscriber) {
    if (subscriber) this.subscribers.add(subscriber);
  }

  get events(): readonly IRuntimeEvent[] {
    return this.runtimeEvents;
  }

  get frames(): readonly LocalRuntimeProjectionFrame[] {
    return this.projectedFrames;
  }

  subscribe(subscriber: LocalEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  snapshot(): LocalEventSinkSnapshot {
    return {
      events: [...this.runtimeEvents],
      frames: [...this.projectedFrames],
    };
  }

  async pushRuntime(event: IRuntimeEvent): Promise<void> {
    this.runtimeEvents.push(event);
    const frame = projectLocalRuntimeEvent(event);
    if (!frame) return;
    this.projectedFrames.push(frame);
    for (const subscriber of this.subscribers) {
      await subscriber(frame, event);
    }
  }

  async appendEvents(events: IRuntimeEvent[]): Promise<void> {
    for (const event of events) {
      await this.pushRuntime(event);
    }
  }
}
