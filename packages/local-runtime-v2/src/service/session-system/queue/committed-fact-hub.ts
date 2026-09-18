import type { QueueCommittedFactSink } from './committed-service.js';
import type { QueueCommittedFact } from './repo/contract.js';

export type QueueCommittedFactSubscriber = (facts: readonly QueueCommittedFact[]) => void;

/**
 * Keeps Queue fact ownership in SessionSystem while allowing TurnSystem to
 * settle live submit completion handles from committed removal facts.
 */
export class QueueCommittedFactHub implements QueueCommittedFactSink {
  private readonly subscribers = new Set<QueueCommittedFactSubscriber>();

  constructor(private readonly downstream: QueueCommittedFactSink) {}

  handle(facts: readonly QueueCommittedFact[]): void {
    this.downstream.handle(facts);
    for (const subscriber of this.subscribers) subscriber(facts);
  }

  subscribe(subscriber: QueueCommittedFactSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}
