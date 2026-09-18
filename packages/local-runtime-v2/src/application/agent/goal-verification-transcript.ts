import { type TranscriptWindowReader } from '@mavis/goal';

const MAX_MESSAGES = 200;

export function createGoalVerificationTranscriptReader(history: {
  inspectActive(sessionId: string): Promise<{ readonly messages: readonly unknown[] }>;
}): TranscriptWindowReader {
  return {
    capture: async (sessionId) => {
      const snapshot = await history.inspectActive(sessionId);
      // Keep the newest complete messages for evidence extraction. Exact rendered
      // byte/character caps are applied later by the shared evidence assembler;
      // applying a compact-JSON cap here used to turn one oversized newest
      // message into an empty verifier transcript.
      const messages = snapshot.messages.slice(-MAX_MESSAGES);
      const truncated = messages.length < snapshot.messages.length;
      return {
        messages: structuredClone(messages),
        truncated,
        ...(truncated
          ? {
              truncationNote: `Captured the newest ${messages.length} messages for Goal verifier evidence assembly.`,
            }
          : {}),
      };
    },
  };
}
