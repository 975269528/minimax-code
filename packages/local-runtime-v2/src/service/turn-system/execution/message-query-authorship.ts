import type {
  AgentHostTurnProvenance,
  AgentHostUserInput,
} from '../agent-host/preparation/contracts.js';

interface MessageQueryAuthorshipInput {
  readonly input: Pick<AgentHostUserInput, 'text'>;
  readonly provenance: Pick<AgentHostTurnProvenance, 'source'>;
  readonly delivery?: {
    readonly hideUserMessage?: boolean;
    readonly displayContent?: string;
  };
}

/** Resolves exact user-query authorship before execution and display diverge. */
export function resolveGenuineUserQueryText(input: MessageQueryAuthorshipInput): string {
  const displayContent = input.delivery?.displayContent;
  if (typeof displayContent === 'string' && displayContent.length > 0) return displayContent;
  if (input.delivery?.hideUserMessage === true) return '';
  return isUserAuthoredSource(input.provenance.source) ? input.input.text : '';
}

export function isUserAuthoredSource(source: string): boolean {
  return (
    source === 'api' ||
    source === 'code_review' ||
    source === 'channel' ||
    source.startsWith('channel:')
  );
}

/** Identifies queued user work that must preempt an autonomous Goal continuation. */
export function hasPriorityUserQueueItem(items: readonly { readonly source: string }[]): boolean {
  return items.some(
    ({ source }) =>
      source === 'api' ||
      source === 'questionnaire' ||
      source === 'communication' ||
      source === 'code_review' ||
      source.startsWith('channel:'),
  );
}
