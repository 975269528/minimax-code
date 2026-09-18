import type { RuntimeConversation } from '@mavis/conversation-contract';

export function normalizeSubagentFinalText(text: string): string {
  if (!/^\s*<annotation-result\b/iu.test(text)) return text;
  return text.replace(/(<annotation-result\b[^>]*\bmode=)(["'])inline\2/iu, '$1$2subagent$2');
}

export function isProjectedReviewResult(text: string): boolean {
  return /^\s*<annotation-result\b[\s\S]*<\/annotation-result>\s*$/iu.test(text);
}

export async function waitForReviewCompletion(
  conversation: RuntimeConversation,
  sessionId: string,
  completion: Promise<{
    readonly status: 'completed' | 'aborted' | 'failed';
    readonly messages: readonly {
      readonly role?: string;
      readonly text?: string;
    }[];
    readonly error?: string;
  }>,
  signal?: AbortSignal,
) {
  if (!signal) return completion;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<Awaited<typeof completion>>((resolve) => {
    onAbort = () => {
      void conversation.ingress.abort(sessionId, 'review_parent_aborted');
      resolve({ status: 'aborted', messages: [] });
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([completion, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
