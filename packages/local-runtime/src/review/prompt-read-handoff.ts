import { randomUUID } from 'node:crypto';

import type { InternalTurnPromptReadRegistry, PromptReadScope } from '@mavis/agent-core';

export type ReviewPromptReadHandoff =
  | { readonly requestedTurnId: string }
  | {
      readonly requestedTurnId: string;
      readonly promptRead: PromptReadScope;
      readonly registry: InternalTurnPromptReadRegistry;
    };

/** Reserves the child Turn before submission so preflight consumes its rendered snapshot. */
export function reserveReviewPromptRead(
  promptRead: PromptReadScope | undefined,
  registry: InternalTurnPromptReadRegistry | undefined,
): ReviewPromptReadHandoff | undefined {
  const requestedTurnId = `turn_review_${randomUUID()}`;
  if (!promptRead) return { requestedTurnId };
  if (!registry?.reserve(requestedTurnId)) return undefined;
  return { requestedTurnId, promptRead, registry };
}

export function rememberReviewPromptRead(handoff: ReviewPromptReadHandoff): void {
  if ('registry' in handoff) handoff.registry.remember(handoff.requestedTurnId, handoff.promptRead);
}

export function rebindReviewPromptRead(handoff: ReviewPromptReadHandoff, turnId: string): void {
  if ('registry' in handoff && handoff.requestedTurnId !== turnId) {
    handoff.registry.rebind(handoff.requestedTurnId, turnId);
  }
}

export function discardReviewPromptRead(handoff: ReviewPromptReadHandoff, turnId: string): void {
  if ('registry' in handoff) handoff.registry.discard(turnId);
}
