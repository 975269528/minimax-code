import type { AppDb } from '../../../../infra/db/client.js';
import type { SessionRepository } from '../../sessions/repo/contract.js';

export interface SessionInputSummaryMessageHead {
  readonly msgId: string;
  readonly timestamp: number;
  readonly contentHead?: string;
}

export interface SessionInputSummaryArtifact {
  readonly messageId: string;
  readonly messageCreatedAtMs: number;
  readonly assetIndex: number;
  readonly assetKey: string;
  readonly sourceTag: string;
  readonly path: string;
  readonly name: string | null;
  readonly assetType: string | null;
  readonly dataJson: string;
}

export interface SessionInputSummary {
  readonly userInput: SessionInputSummaryMessageHead;
  readonly assistantResponse?: SessionInputSummaryMessageHead;
  readonly artifacts: readonly SessionInputSummaryArtifact[];
  readonly fileChangeCount: number;
}

export interface SessionInputSummaryPage {
  readonly summaries: readonly SessionInputSummary[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface SessionInputSummaryListInput {
  readonly sessionId: string;
  readonly limit?: number;
  readonly before?: string;
}

export interface SessionInputNavigationDiff {
  readonly assistantMessageId?: string;
  readonly filePaths: readonly string[];
}

export interface SessionInputNavigationDiffReader {
  listSessionDiffs(sessionId: string): Promise<readonly SessionInputNavigationDiff[]>;
}

export interface SessionInputSummaryReadiness {
  ensureDisplayReady(sessionId: string): Promise<void>;
  ensureAssetsReady(sessionId: string): Promise<void>;
}

export interface SessionInputSummaryServiceOptions {
  readonly db: AppDb;
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly readiness: SessionInputSummaryReadiness;
  readonly diffs: SessionInputNavigationDiffReader;
}
