export interface TranscriptWindowResult<M> {
  readonly messages: readonly M[];
  readonly truncated: boolean;
}

/**
 * Retain one bounded suffix of a verifier transcript. Whole messages are kept
 * or dropped; an oversized newest message therefore yields an empty, marked
 * transcript instead of silently slicing structured evidence.
 */
export function boundVerificationTranscript<M>(
  messages: readonly M[],
  limits: { readonly maxMessages: number; readonly maxChars: number },
  sizeOf: (message: M) => number,
): TranscriptWindowResult<M> {
  const maxMessages = nonNegativeInteger(limits.maxMessages);
  const maxChars = nonNegativeInteger(limits.maxChars);
  let retained = 0;
  let retainedChars = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (retained >= maxMessages) break;
    const message = messages[index];
    if (message === undefined) break;
    const messageChars = nonNegativeInteger(sizeOf(message));
    if (messageChars > maxChars - retainedChars) break;
    retained += 1;
    retainedChars += messageChars;
  }

  return {
    messages: retained === messages.length ? messages : messages.slice(messages.length - retained),
    truncated: retained < messages.length,
  };
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
