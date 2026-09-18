import type { DisplayMessageRecord, MessageRepository } from './repo/contract.js';

export interface StaleCompactionMessageRepairOptions {
  readonly messages: Pick<MessageRepository, 'upsert'>;
  readonly processStartedAtMs: number;
}

export class StaleCompactionMessageRepair {
  constructor(private readonly options: StaleCompactionMessageRepairOptions) {}

  async repair(
    sessionId: string,
    messages: readonly DisplayMessageRecord[],
  ): Promise<readonly DisplayMessageRecord[]> {
    const lastIndex = messages.length - 1;
    const reconciled = [...messages];
    for (const [index, message] of messages.entries()) {
      if (message.kind !== 'compaction_start') continue;
      const emittedByThisProcess =
        typeof message.timestamp === 'number' &&
        message.timestamp >= this.options.processStartedAtMs;
      if (emittedByThisProcess && index === lastIndex) continue;
      const patched: DisplayMessageRecord = { ...message, kind: 'compaction_failed' };
      await this.options.messages.upsert({ sessionId, message: patched });
      reconciled[index] = patched;
    }
    return reconciled;
  }
}
