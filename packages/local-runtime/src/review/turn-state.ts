import type { PendingReviewProjection } from './candidates.js';
import type { PreparedReview } from './preparation.js';
import type { ReviewContextDelivery, ReviewOutcome } from './types.js';

export type ReviewTurnPhase =
  | 'idle'
  | 'inline_active'
  | 'subagent_running'
  | 'subagent_result_ready'
  | 'finalized';

export class ReviewTurnState {
  private currentPhase: ReviewTurnPhase = 'idle';
  private preparedReview?: PreparedReview;
  private acceptedText?: string;
  private acceptedOutcome?: ReviewOutcome;
  private pendingReviewProjection?: PendingReviewProjection;
  private invalidCandidateAttempts = 0;
  private contextDelivery: ReviewContextDelivery = 'full';
  private fullReminder?: string;
  private compactReminder?: string;

  get phase(): ReviewTurnPhase {
    return this.currentPhase;
  }

  get prepared(): PreparedReview | undefined {
    return this.preparedReview;
  }

  get projectedText(): string | undefined {
    return this.acceptedText;
  }

  get outcome(): ReviewOutcome | undefined {
    return this.acceptedOutcome;
  }

  get delivery(): ReviewContextDelivery {
    return this.contextDelivery;
  }

  get renderedFullReminder(): string | undefined {
    return this.fullReminder;
  }

  get renderedCompactReminder(): string | undefined {
    return this.compactReminder;
  }

  isReviewActivated(): boolean {
    return this.currentPhase !== 'idle';
  }

  activate(
    prepared: PreparedReview,
    reminders?: { readonly fullReminder: string; readonly compactReminder: string },
    initialDelivery: ReviewContextDelivery = 'full',
  ): void {
    this.preparedReview = prepared;
    this.acceptedText = undefined;
    this.acceptedOutcome = undefined;
    this.pendingReviewProjection = undefined;
    this.invalidCandidateAttempts = 0;
    this.contextDelivery = initialDelivery;
    this.fullReminder = reminders?.fullReminder;
    this.compactReminder = reminders?.compactReminder;
    this.currentPhase = prepared.mode === 'subagent' ? 'subagent_running' : 'inline_active';
  }

  useGitDiscovery(): void {
    this.contextDelivery = 'git-discovery';
  }

  isProjectionActive(): boolean {
    return (
      this.currentPhase === 'inline_active' ||
      this.currentPhase === 'subagent_running' ||
      this.currentPhase === 'subagent_result_ready'
    );
  }

  setSubagentResult(projectedText: string): void {
    if (!this.preparedReview || this.preparedReview.mode !== 'subagent') {
      throw new Error('Cannot attach a subagent result to an inactive inline review');
    }
    this.acceptedText = projectedText;
    this.currentPhase = 'subagent_result_ready';
  }

  getSubagentResult(): string | undefined {
    return this.currentPhase === 'subagent_result_ready' ? this.acceptedText : undefined;
  }

  setPendingProjection(projection: PendingReviewProjection): void {
    if (!this.isProjectionActive()) {
      throw new Error('Cannot save Review candidates outside an active Review turn');
    }
    this.pendingReviewProjection = projection;
  }

  getPendingProjection(): PendingReviewProjection | undefined {
    return this.pendingReviewProjection;
  }

  clearPendingProjection(): void {
    this.pendingReviewProjection = undefined;
  }

  consumeInvalidCandidateRetry(): boolean {
    if (this.invalidCandidateAttempts >= 1) return false;
    this.invalidCandidateAttempts += 1;
    return true;
  }

  finalize(projectedText?: string, outcome?: ReviewOutcome): void {
    if (projectedText !== undefined) this.acceptedText = projectedText;
    if (outcome !== undefined) this.acceptedOutcome = outcome;
    this.pendingReviewProjection = undefined;
    this.currentPhase = 'finalized';
  }
}
