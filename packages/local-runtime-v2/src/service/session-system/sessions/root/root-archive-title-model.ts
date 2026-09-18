import type { SessionRecord } from '../repo/contract.js';

export interface RootArchiveTitleModelInput {
  readonly session: SessionRecord;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface RootArchiveTitleModel {
  summarize(input: RootArchiveTitleModelInput): Promise<string | null>;
}

export interface RootArchiveTitleSafetyVerdict {
  readonly pass: boolean;
  readonly errorKind?: 'rejected' | 'api_error' | 'local_error' | 'auth_error';
}

export type RootArchiveTitleModelStage = 'model' | 'review';

export class RootArchiveTitleModelError extends Error {
  constructor(
    readonly stage: RootArchiveTitleModelStage,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RootArchiveTitleModelError';
  }
}
