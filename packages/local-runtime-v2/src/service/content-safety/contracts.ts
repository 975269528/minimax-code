export interface SafetyCheckResult {
  readonly pass: boolean;
  readonly action?: 'allow' | 'reject' | 'replace' | 'guide';
  /** Model-only instruction; never project into user-visible events. */
  readonly guide_prompt?: string;
  /** Keep retries on V2 after a streaming-window V2 transport failure. */
  readonly retryWithV2?: boolean;
  readonly reason?: string;
  readonly suggestion?: string;
  readonly errorKind?: 'rejected' | 'api_error' | 'local_error' | 'auth_error';
}

export const SAFETY_SCENE = {
  MessageOutput: 1,
  StreamChunk: 2,
  ThinkingContent: 3,
  ConfigField: 205,
  UserInput: 300,
} as const;

export type SafetyScene = (typeof SAFETY_SCENE)[keyof typeof SAFETY_SCENE];

/** Product-owned transport port. The concrete managed HTTP client remains in v1. */
export type ContentSafetyReviewPort = (
  content: string,
  scene: SafetyScene,
) => Promise<SafetyCheckResult>;

/** A reusable input verdict bound to one immutable Turn input snapshot. */
export interface InputSafetyDecision {
  readonly inputDigest: string;
  readonly outcome: 'approved' | 'degraded';
}
