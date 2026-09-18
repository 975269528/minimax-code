export type ReviewMode = 'inline' | 'subagent';
export type ReviewTrigger = 'slash' | 'natural_language';
export type ReviewContextDelivery = 'full' | 'git-discovery';
export type ReviewPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ReviewDiffSide = 'old' | 'new';
export type ReviewOutcome = 'pass' | 'needs_changes' | 'failed';

export interface ReviewLineRange {
  startLine: number;
  endLine: number;
}

export interface ReviewChangedRange extends ReviewLineRange {
  side: ReviewDiffSide;
  kind: 'added' | 'deleted' | 'modified';
}

export interface ReviewChangedFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  ranges: ReviewChangedRange[];
}

export interface ReviewAnchor {
  revision: `sha256:${string}`;
  contextBefore: number;
  contextAfter: number;
  targetText: string;
}

export interface ProjectedReviewAnnotation {
  id: string;
  priority: ReviewPriority;
  targetType: 'line-range' | 'file';
  path: string;
  side?: ReviewDiffSide;
  startLine?: number;
  endLine?: number;
  title: string;
  content: string;
  anchorRevision?: `sha256:${string}`;
  contextBefore?: number;
  contextAfter?: number;
  fileState?: 'deleted';
  blobRevision?: `git-blob:${string}`;
  relatedChange?: {
    path: string;
    side: ReviewDiffSide;
    startLine: number;
    endLine: number;
    revision: `sha256:${string}`;
  };
}

export type AnnotationTargetStatus =
  | 'current'
  | 'relocated'
  | 'changed'
  | 'missing'
  | 'unverified'
  | 'invalid';

export interface AnnotationTargetResolution {
  status: AnnotationTargetStatus;
  targetType?: 'line-range' | 'file';
  path?: string;
  side?: ReviewDiffSide;
  startLine?: number;
  endLine?: number;
  revision?: `sha256:${string}`;
  contextBefore?: number;
  contextAfter?: number;
  targetText?: string;
  fileState?: 'deleted';
  blobRevision?: `git-blob:${string}`;
  message?: string;
}
