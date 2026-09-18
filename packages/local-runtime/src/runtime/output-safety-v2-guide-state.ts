/** Model-only guide retained after blocking an attempt, consumed once by the host. */
export class OutputSafetyV2GuideState {
  private guidePrompt: string | undefined;
  private guideReviewed = false;

  isGuideReviewed(): boolean {
    return this.guideReviewed;
  }

  /** Record a reject+guide_prompt match. Multiple matches in one attempt overwrite the previous guidance. */
  mark(guidePrompt: string): void {
    this.guidePrompt = guidePrompt;
    this.guideReviewed = true;
  }

  /**
   * Consume the latest matched review guidance once and clear guideReviewed, preventing repeated
   * reads in one attempt or leakage across attempts.
   */
  consume(): string | undefined {
    const out = this.guidePrompt;
    this.guidePrompt = undefined;
    this.guideReviewed = false;
    return out;
  }

  /** Called once by the host at each attempt boundary to prevent state leaking between attempts. */
  reset(): void {
    this.guidePrompt = undefined;
    this.guideReviewed = false;
  }
}
