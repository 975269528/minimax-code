import type { AppDb } from '../../../../infra/db/client.js';

export interface SessionAssetRecord {
  readonly id: number;
  readonly sessionId: string;
  readonly messageId: string;
  readonly messageCreatedAtMs: number;
  readonly assetKey: string;
  readonly sourceTag: string;
  readonly path: string;
  readonly name: string | null;
  readonly assetType: string | null;
  readonly dataJson: string;
}

export interface SessionAssetIndexState {
  readonly sessionId: string;
  readonly indexVersion: number;
  readonly indexedThroughMessageRowId: number;
  readonly indexedAtMs: number;
  readonly status: string;
  readonly errorJson: string | null;
}

export interface SessionAssetCopyResult {
  readonly mode: SessionAssetCopyMode;
  readonly targetRoot?: string;
  readonly copiedPaths: readonly string[];
}

export type SessionAssetCopyMode = 'records-only' | 'workspace-copy';

export type SessionAssetCopyInput = {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageIds: readonly string[];
} & (
  | { readonly mode: 'records-only' }
  | {
      readonly mode: 'workspace-copy';
      readonly sourceWorkspaceDir: string;
      readonly targetWorkspaceDir: string;
    }
);

export interface SessionAssetPageOptions {
  readonly sessionId: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionAssetPage {
  readonly assets: readonly SessionAssetRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface SessionAssetRepository {
  getIndexState(sessionId: string): Promise<SessionAssetIndexState | undefined>;
  rebuild(sessionId: string, nowMs: number): Promise<SessionAssetIndexState>;
  listPage(options: SessionAssetPageOptions): Promise<SessionAssetPage>;
  deleteSession(sessionId: string): Promise<void>;
  copyForMessagePrefix(input: SessionAssetCopyInput): Promise<SessionAssetCopyResult>;
  probeCopy(input: {
    readonly sessionId: string;
    /** Missing only for recovery of manifests written before copy modes existed. */
    readonly mode?: SessionAssetCopyMode;
    readonly targetRoot?: string;
    readonly copiedPaths: readonly string[];
  }): Promise<boolean>;
  compensateCopy(input: {
    readonly sessionId: string;
    /** Missing only for recovery of manifests written before copy modes existed. */
    readonly mode?: SessionAssetCopyMode;
    readonly copiedPaths?: readonly string[];
    readonly targetRoot?: string;
  }): Promise<void>;
}

export interface SessionAssetRepositoryOptions {
  readonly db: AppDb;
  readonly resolveSessionWorkspaceRoot?: (sessionId: string) => Promise<string | undefined>;
  /** Resolves the pre-copy-mode root only for recovery compatibility. */
  readonly resolveLegacySessionAssetRoot?: (sessionId: string) => string | undefined;
}
