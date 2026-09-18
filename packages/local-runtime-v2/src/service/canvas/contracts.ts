import type { AppDb } from '../../infra/db/client.js';
import type { SessionRecord } from '../session-system/index.js';

export interface CanvasLayoutV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

interface CanvasNormalizedRectV1 {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasImageAnnotationV1 {
  readonly id: string;
  readonly number: number;
  readonly normalizedRect: CanvasNormalizedRectV1;
  readonly comment: string;
  readonly action: 'comment' | 'erase';
  readonly createdAtMs: number;
}

export interface CanvasFileNodeV1 {
  readonly id: string;
  readonly type: 'file_ref';
  readonly file: {
    readonly relativePath: string;
    readonly assetId?: string;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly sizeBytes?: number;
    readonly sha256?: string;
  };
  readonly layout: CanvasLayoutV1;
  readonly annotations: readonly CanvasImageAnnotationV1[];
}

export interface CanvasDocumentV1 {
  readonly schemaVersion: 1;
  readonly canvasId: string;
  readonly sessionId: string;
  readonly changeSeq: number;
  readonly nodes: readonly CanvasFileNodeV1[];
  readonly updatedAtMs: number;
}

export type CanvasMutationV1 =
  | ({
      readonly kind: 'add_file';
      readonly nodeId: string;
      readonly layout: CanvasLayoutV1;
    } & (
      | { readonly relativePath: string; readonly assetId?: never }
      | { readonly assetId: string; readonly relativePath?: never }
    ))
  | {
      readonly kind: 'update_layout';
      readonly nodeId: string;
      readonly layout: CanvasLayoutV1;
    }
  | {
      readonly kind: 'remove_node';
      readonly nodeId: string;
    }
  | {
      readonly kind: 'add_annotation';
      readonly nodeId: string;
      readonly annotation: CanvasImageAnnotationV1;
    }
  | {
      readonly kind: 'update_annotation';
      readonly nodeId: string;
      readonly annotation: CanvasImageAnnotationV1;
    }
  | {
      readonly kind: 'remove_annotation';
      readonly nodeId: string;
      readonly annotationId: string;
    };

export interface CanvasOperationV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly mutations: readonly CanvasMutationV1[];
}

export interface CanvasApplyResultV1 {
  readonly operationId: string;
  readonly document: CanvasDocumentV1;
}

export type CanvasFileTargetV1 =
  | {
      readonly id: string;
      readonly kind: 'workspace';
      readonly relativePath: string;
    }
  | {
      readonly id: string;
      readonly kind: 'asset';
      readonly assetId: string;
    }
  | {
      readonly id: string;
      readonly kind: 'session_deliverable';
      readonly sourcePath: string;
    }
  | {
      readonly id: string;
      readonly kind: 'external_file';
      readonly sourcePath: string;
    };

export interface PreparedCanvasFileV1 {
  readonly id: string;
  readonly relativePath: string;
  readonly assetId?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

export type CanvasServiceErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'WORKSPACE_UNAVAILABLE'
  | 'INVALID_OPERATION'
  | 'INVALID_FILE_REFERENCE'
  | 'FILE_ALREADY_ON_CANVAS'
  | 'NODE_ALREADY_EXISTS'
  | 'NODE_NOT_FOUND'
  | 'OPERATION_ID_REUSED'
  | 'PERSISTENCE_FAILED';

export class CanvasServiceError extends Error {
  constructor(
    readonly code: CanvasServiceErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'CanvasServiceError';
  }
}

interface CanvasSessionReader {
  get(sessionId: string): Promise<SessionRecord | undefined>;
}

export interface CanvasAssetResolution {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly absolutePath: string;
}

interface CanvasAssetReader {
  importDeliverable(input: {
    readonly sessionId: string;
    readonly path: string;
  }): Promise<CanvasAssetResolution | undefined>;
  importExternal(input: {
    readonly sessionId: string;
    readonly path: string;
  }): Promise<CanvasAssetResolution | undefined>;
  resolve(input: {
    readonly sessionId: string;
    readonly assetId: string;
  }): Promise<CanvasAssetResolution | undefined>;
}

export interface CanvasServiceOptions {
  readonly db: AppDb;
  readonly sessions: CanvasSessionReader;
  readonly assets: CanvasAssetReader;
  readonly nowMs?: () => number;
}

export interface CanvasService {
  read(input: { readonly sessionId: string }): Promise<CanvasDocumentV1>;
  prepareFiles(input: {
    readonly sessionId: string;
    readonly targets: readonly CanvasFileTargetV1[];
  }): Promise<readonly PreparedCanvasFileV1[]>;
  apply(input: {
    readonly sessionId: string;
    readonly operation: CanvasOperationV1;
  }): Promise<CanvasApplyResultV1>;
  deleteSession(sessionId: string): Promise<void>;
}
