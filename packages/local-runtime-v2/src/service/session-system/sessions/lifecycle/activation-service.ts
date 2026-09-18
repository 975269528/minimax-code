import type { SessionRecord } from '../repo/contract.js';
import type { SessionFactSink } from './record-service.js';

export interface SessionActivationWriter {
  reopenArchivedSession(sessionId: string): Promise<SessionRecord | undefined>;
}

export interface SessionActivationServiceOptions {
  readonly writer: SessionActivationWriter;
  readonly facts: SessionFactSink;
}

export class SessionActivationService {
  constructor(private readonly options: SessionActivationServiceOptions) {}

  async prepareForUserActivation(sessionId: string): Promise<SessionRecord | undefined> {
    const updated = await this.options.writer.reopenArchivedSession(sessionId);
    if (!updated) return undefined;
    if (updated.archived) {
      throw new Error(`Session ${sessionId} remained archived after activation preparation.`);
    }
    this.options.facts.handle({ kind: 'archive-changed', sessionId, archived: false });
    return freezeSnapshot(updated);
  }
}

function freezeSnapshot(record: SessionRecord): SessionRecord {
  const runLocation = record.runLocation ? Object.freeze({ ...record.runLocation }) : undefined;
  return Object.freeze({ ...record, runLocation });
}
