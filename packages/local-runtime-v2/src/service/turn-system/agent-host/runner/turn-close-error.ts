export class AgentHostTurnCloseError extends Error {
  override readonly name = 'AgentHostTurnCloseError';

  constructor(
    readonly reason: 'stale-lease' | 'aborted',
    readonly abortReason?: string,
  ) {
    super(
      reason === 'aborted' && abortReason
        ? `Accepted Turn was aborted before close: ${abortReason}.`
        : `Accepted Turn close failed: ${reason}.`,
    );
  }
}
