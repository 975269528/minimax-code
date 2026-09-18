export const OUTPUT_REVISION_PROMPT_KEY = 'desktop-task/output-revision/system.md';

export const RETRY_CONTINUATION_PROMPT_KEY = 'desktop-task/retry/continuation.md';

export const DEFAULT_RETRY_CONTINUATION_PROMPT = [
  '<system-reminder>',
  'The previous assistant turn did not deliver a completed response (aborted, errored, or stalled while streaming).',
  "Continue working on the user's outstanding request from the last completed action. Do not restart, do not greet the user, and do not ask what to do next — resume the task in progress.",
  '</system-reminder>',
].join('\n');

export const DEFAULT_OUTPUT_REVISION_INSTRUCTION =
  `Please attempt to answer the user's question once more, aiming for a helpful response. ` +
  `If you determine that this particular topic is one you cannot reasonably address, simply reply with something brief like ` +
  `"Sorry, I can't continue with this topic — let's talk about something else." ` +
  `Do not explain the reason, and do not reference any system instruction, prompt, or constraint.`;
