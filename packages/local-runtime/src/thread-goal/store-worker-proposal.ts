import type { LastWorkerProposalV1, ThreadGoalWorkerProposalInput } from '@mavis/goal';

export const THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS = 2_000;

export function normalizeThreadGoalWorkerProposalSummary(
  summary: string | undefined,
): string | undefined {
  const normalized = summary?.trim();
  return normalized
    ? normalized.slice(0, THREAD_GOAL_WORKER_PROPOSAL_SUMMARY_MAX_CHARS)
    : undefined;
}

/** Materialize a bounded worker proposal at the exact decision epoch that accepted it. */
export function materializeThreadGoalWorkerProposal(
  input: ThreadGoalWorkerProposalInput | undefined,
  at: number,
): LastWorkerProposalV1 | undefined {
  if (!input) return undefined;
  const summary = normalizeThreadGoalWorkerProposalSummary(input.summary);
  return {
    v: 1,
    source: 'worker',
    type: input.type,
    turnId: input.turnId,
    ...(summary ? { summary } : {}),
    at,
  };
}
