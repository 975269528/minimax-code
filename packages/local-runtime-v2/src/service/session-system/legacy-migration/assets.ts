export interface LegacyImportedAssetInput {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sourcePath?: string;
  readonly dataUrl?: string;
  readonly sourceKind: 'legacy-migration';
  readonly sessionId: string;
  readonly nowMs: () => number;
}

export interface LegacyImportedAsset {
  readonly assetId: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Narrow file-owner capability; the concrete asset store remains outside session-system. */
export interface LegacyImportedAssetPort {
  register(input: LegacyImportedAssetInput): Promise<LegacyImportedAsset>;
}
