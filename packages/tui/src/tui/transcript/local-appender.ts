import type { TranscriptInspectionReport } from './model.js';
import type { TranscriptStore } from './store.js';

export type LocalTranscriptCellKind = 'final-summary' | 'warning' | 'error' | 'inspection';

export interface LocalTranscriptAppenderOptions {
  readonly transcript: TranscriptStore;
  readonly isStopped: () => boolean;
  readonly onChanged: () => void;
}

export function createLocalTranscriptAppender(
  options: LocalTranscriptAppenderOptions,
): (
  content: string,
  kind?: LocalTranscriptCellKind,
  inspection?: TranscriptInspectionReport,
) => void {
  let sequence = 0;
  return (content, kind = 'final-summary', inspection) => {
    if (options.isStopped()) return;
    const now = Date.now();
    sequence += 1;
    options.transcript.upsert({
      id: `local:${sequence}`,
      kind,
      status: kind === 'error' ? 'failed' : 'succeeded',
      content,
      ...(inspection ? { inspection } : {}),
      ephemeral: true,
      createdAtMs: now,
      updatedAtMs: now,
    });
    options.onChanged();
  };
}
