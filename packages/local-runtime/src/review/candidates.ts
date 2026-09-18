import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

import {
  createReviewAnchor,
  createReviewChangeAnchor,
  validateReviewTargetPath,
} from './annotation-target.js';
import type {
  ProjectedReviewAnnotation,
  ReviewChangedFile,
  ReviewChangedRange,
  ReviewDiffSide,
  ReviewMode,
  ReviewTrigger,
} from './types.js';
import {
  getReviewCandidateFindingParseError,
  parseReviewCandidateCorrectionsXml,
  parseReviewCandidateXml,
} from './candidate-xml.js';

const execFileAsync = promisify(execFile);

const lineTargetSchema = z
  .object({
    type: z.literal('line-range'),
    path: z.string().min(1),
    side: z.enum(['old', 'new']),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be greater than or equal to startLine',
  });

const fileTargetSchema = z
  .object({
    type: z.literal('file'),
    path: z.string().min(1),
    state: z.literal('deleted'),
  })
  .strict();

const relatedChangeSchema = z
  .object({
    path: z.string().min(1),
    side: z.enum(['old', 'new']),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be greater than or equal to startLine',
  });

const findingSchema = z
  .object({
    priority: z.enum(['P0', 'P1', 'P2', 'P3']),
    target: z.union([lineTargetSchema, fileTargetSchema]),
    relatedChange: relatedChangeSchema.optional(),
    title: z.string(),
    content: z.string(),
  })
  .strict();

const reviewCandidateSchema = z.discriminatedUnion('verdict', [
  z
    .object({
      type: z.literal('code_review_candidates'),
      version: z.literal(2),
      summary: z.string(),
      verdict: z.literal('pass'),
      findings: z.array(z.unknown()).length(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('code_review_candidates'),
      version: z.literal(2),
      summary: z.string(),
      verdict: z.literal('needs-changes'),
      findings: z.array(z.unknown()).min(1),
    })
    .strict(),
]);

const correctionSchema = z.discriminatedUnion('action', [
  z
    .object({
      candidateKey: z.string().regex(/^finding_\d+$/u),
      action: z.literal('replace'),
      finding: z.unknown(),
    })
    .strict(),
  z
    .object({
      candidateKey: z.string().regex(/^finding_\d+$/u),
      action: z.literal('drop'),
    })
    .strict(),
]);

const correctionsSchema = z
  .object({
    type: z.literal('code_review_candidate_corrections'),
    version: z.literal(1),
    corrections: z.array(correctionSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set<string>();
    for (const correction of value.corrections) {
      if (keys.has(correction.candidateKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['corrections'],
          message: `Duplicate candidateKey: ${correction.candidateKey}`,
        });
      }
      keys.add(correction.candidateKey);
    }
  });

export type ReviewCandidates = z.infer<typeof reviewCandidateSchema>;
export type ReviewChangeCandidates = Extract<ReviewCandidates, { verdict: 'needs-changes' }>;
export type ReviewFindingCandidate = z.infer<typeof findingSchema>;
export type ReviewCandidateCorrections = z.infer<typeof correctionsSchema>;

export interface ReviewProjectionContext {
  workspace: string;
  reviewRunId: string;
  trigger: ReviewTrigger;
  mode: ReviewMode;
  /**
   * Undefined means Git preparation was unavailable and overlap cannot be
   * verified. A defined map is authoritative, including an empty map.
   */
  changedFiles?: ReadonlyMap<string, ReviewChangedFile>;
}

export interface ProjectedReviewResult {
  summary: string;
  verdict: 'needs-changes';
  annotations: ProjectedReviewAnnotation[];
  xml: string;
}

export interface InvalidReviewFinding {
  candidateKey: string;
  finding: unknown;
  diagnostic: {
    message: string;
    path?: string;
    changedRanges: ReviewChangedRange[];
  };
}

export interface ReviewProjectionPartition {
  summary: string;
  verdict: 'needs-changes';
  annotations: ProjectedReviewAnnotation[];
  invalid: InvalidReviewFinding[];
}

export type PendingReviewProjection = ReviewProjectionPartition;

export interface ReviewCorrectionApplication {
  annotations: ProjectedReviewAnnotation[];
  explicitlyDropped: number;
  failedCorrections: number;
}

export function parseReviewCandidateText(text: string): ReviewCandidates {
  return reviewCandidateSchema.parse(parseReviewCandidateXml(text));
}

export function parseReviewCandidateCorrections(text: string): ReviewCandidateCorrections {
  return correctionsSchema.parse(parseReviewCandidateCorrectionsXml(text));
}

export async function parseAndProjectReviewCandidates(
  text: string,
  context: ReviewProjectionContext,
): Promise<ProjectedReviewResult> {
  const candidates = parseReviewCandidateText(text);
  if (candidates.verdict !== 'needs-changes') {
    throw new Error('A passing review has no findings to project');
  }
  const partition = await projectReviewCandidates(candidates, context);
  const invalid = partition.invalid[0];
  if (invalid) {
    throw new Error(invalid.diagnostic.message);
  }
  return finalizeReviewProjection({
    context,
    summary: partition.summary,
    annotations: partition.annotations,
  });
}

export async function projectReviewCandidates(
  candidates: ReviewChangeCandidates,
  context: ReviewProjectionContext,
): Promise<ReviewProjectionPartition> {
  const annotations: ProjectedReviewAnnotation[] = [];
  const invalid: InvalidReviewFinding[] = [];
  for (const [index, rawFinding] of candidates.findings.entries()) {
    const candidateKey = `finding_${index + 1}`;
    const parsed = findingSchema.safeParse(rawFinding);
    if (!parsed.success) {
      const xmlParseError = getReviewCandidateFindingParseError(rawFinding);
      invalid.push({
        candidateKey,
        finding: rawFinding,
        diagnostic: buildFindingDiagnostic({
          context,
          rawFinding,
          error: new Error(
            xmlParseError
              ? `Invalid finding schema: ${xmlParseError}`
              : `Invalid finding schema: ${parsed.error.issues
                  .map((issue) => `${issue.path.join('.') || 'finding'}: ${issue.message}`)
                  .join('; ')}`,
          ),
        }),
      });
      continue;
    }

    try {
      annotations.push(await projectReviewFinding(parsed.data, context));
    } catch (error) {
      invalid.push({
        candidateKey,
        finding: rawFinding,
        diagnostic: buildFindingDiagnostic({ context, rawFinding, error }),
      });
    }
  }
  return {
    summary: candidates.summary,
    verdict: candidates.verdict,
    annotations,
    invalid,
  };
}

export async function applyReviewCandidateCorrections(
  pending: PendingReviewProjection,
  corrections: ReviewCandidateCorrections,
  context: ReviewProjectionContext,
): Promise<ReviewCorrectionApplication> {
  const pendingKeys = new Set(pending.invalid.map((item) => item.candidateKey));
  const correctionsByKey = new Map(
    corrections.corrections
      .filter((correction) => pendingKeys.has(correction.candidateKey))
      .map((correction) => [correction.candidateKey, correction] as const),
  );
  const annotations = [...pending.annotations];
  let explicitlyDropped = 0;
  let failedCorrections = 0;

  for (const invalid of pending.invalid) {
    const correction = correctionsByKey.get(invalid.candidateKey);
    if (!correction) {
      failedCorrections += 1;
      continue;
    }
    if (correction.action === 'drop') {
      explicitlyDropped += 1;
      continue;
    }
    const parsed = findingSchema.safeParse(correction.finding);
    if (!parsed.success) {
      failedCorrections += 1;
      continue;
    }
    try {
      annotations.push(await projectReviewFinding(parsed.data, context));
    } catch {
      failedCorrections += 1;
    }
  }
  return { annotations, explicitlyDropped, failedCorrections };
}

export function finalizeReviewProjection(input: {
  context: ReviewProjectionContext;
  summary: string;
  annotations: ProjectedReviewAnnotation[];
}): ProjectedReviewResult {
  return {
    summary: input.summary,
    verdict: 'needs-changes',
    annotations: input.annotations,
    xml: serializeReviewResult({
      reviewRunId: input.context.reviewRunId,
      trigger: input.context.trigger,
      mode: input.context.mode,
      summary: input.summary,
      verdict: 'needs-changes',
      annotations: input.annotations,
    }),
  };
}

async function projectReviewFinding(
  finding: ReviewFindingCandidate,
  context: ReviewProjectionContext,
): Promise<ProjectedReviewAnnotation> {
  await validateReviewTargetPath(context.workspace, finding.target.path);
  if (finding.target.type === 'file') {
    const changedFile = context.changedFiles?.get(finding.target.path);
    if (context.changedFiles && changedFile?.status !== 'deleted') {
      throw new Error(`Review file target is not deleted: ${finding.target.path}`);
    }
    const blobRevision = await readGitBlobRevision(context.workspace, finding.target.path);
    return {
      id: `annotation_${randomUUID()}`,
      priority: finding.priority,
      targetType: 'file',
      path: finding.target.path,
      fileState: 'deleted',
      blobRevision,
      title: finding.title,
      content: finding.content,
    };
  }

  const target = finding.target;
  const changedFile = context.changedFiles?.get(target.path);
  const targetOverlapsChange = changedFile !== undefined && overlapsAny(target, changedFile.ranges);
  if (target.side === 'old' && !targetOverlapsChange) {
    throw new Error(
      `Old-side review target does not overlap a deleted line: ${target.path}:${target.startLine}`,
    );
  }
  if (context.changedFiles && !targetOverlapsChange && !finding.relatedChange) {
    throw new Error(
      `Review target outside the local changes requires relatedChange: ${target.path}:${target.startLine}`,
    );
  }

  let relatedChange: ProjectedReviewAnnotation['relatedChange'];
  if (finding.relatedChange) {
    await validateReviewTargetPath(context.workspace, finding.relatedChange.path);
    const relatedFile = context.changedFiles?.get(finding.relatedChange.path);
    if (
      context.changedFiles &&
      (!relatedFile || !overlapsAny(finding.relatedChange, relatedFile.ranges))
    ) {
      throw new Error(
        `relatedChange does not overlap the local changes: ${finding.relatedChange.path}:${finding.relatedChange.startLine}`,
      );
    }
    const relatedAnchor = await createReviewChangeAnchor({
      workspace: context.workspace,
      path: finding.relatedChange.path,
      side: finding.relatedChange.side,
      startLine: finding.relatedChange.startLine,
      endLine: finding.relatedChange.endLine,
    });
    relatedChange = {
      ...finding.relatedChange,
      revision: relatedAnchor.revision,
    };
  }

  const anchor = await createReviewAnchor({
    workspace: context.workspace,
    path: target.path,
    side: target.side,
    startLine: target.startLine,
    endLine: target.endLine,
  });
  return {
    id: `annotation_${randomUUID()}`,
    priority: finding.priority,
    targetType: 'line-range',
    path: target.path,
    side: target.side,
    startLine: target.startLine,
    endLine: target.endLine,
    title: finding.title,
    content: finding.content,
    anchorRevision: anchor.revision,
    contextBefore: anchor.contextBefore,
    contextAfter: anchor.contextAfter,
    ...(relatedChange ? { relatedChange } : {}),
  };
}

function buildFindingDiagnostic(input: {
  context: ReviewProjectionContext;
  rawFinding: unknown;
  error: unknown;
}): InvalidReviewFinding['diagnostic'] {
  const path = readCandidatePath(input.rawFinding);
  const message = (
    input.error instanceof Error ? input.error.message : String(input.error)
  ).replaceAll(input.context.workspace, '<workspace>');
  return {
    message,
    ...(path ? { path } : {}),
    changedRanges: path ? [...(input.context.changedFiles?.get(path)?.ranges ?? [])] : [],
  };
}

function readCandidatePath(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const target = Reflect.get(value, 'target');
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const path = Reflect.get(target, 'path');
  return typeof path === 'string' ? path : undefined;
}

function overlapsAny(
  finding: { side: ReviewDiffSide; startLine: number; endLine: number },
  ranges: readonly ReviewChangedRange[],
): boolean {
  return ranges.some(
    (range) =>
      finding.side === range.side &&
      finding.startLine <= range.endLine &&
      finding.endLine >= range.startLine,
  );
}

function serializeReviewResult(input: {
  reviewRunId: string;
  trigger: ReviewTrigger;
  mode: ReviewMode;
  summary: string;
  verdict: 'needs-changes';
  annotations: readonly ProjectedReviewAnnotation[];
}): string {
  const annotations = input.annotations
    .map((annotation) => {
      const target =
        annotation.targetType === 'file'
          ? `      <target type="file" uri="${escapeXmlAttribute(annotation.path)}" state="deleted" blob-revision="${escapeXmlAttribute(annotation.blobRevision ?? '')}" />`
          : [
              `      <target type="file" uri="${escapeXmlAttribute(annotation.path)}">`,
              `        <selector type="line-range" side="${annotation.side}" start-line="${annotation.startLine}" end-line="${annotation.endLine}" anchor-revision="${annotation.anchorRevision}" context-before="${annotation.contextBefore}" context-after="${annotation.contextAfter}" />`,
              ...(annotation.relatedChange
                ? [
                    `        <related-change path="${escapeXmlAttribute(annotation.relatedChange.path)}" side="${annotation.relatedChange.side}" start-line="${annotation.relatedChange.startLine}" end-line="${annotation.relatedChange.endLine}" revision="${annotation.relatedChange.revision}" />`,
                  ]
                : []),
              '      </target>',
            ].join('\n');
      return [
        `    <annotation id="${escapeXmlAttribute(annotation.id)}" kind="code-review" priority="${annotation.priority}">`,
        target,
        `      <title>${escapeXmlText(annotation.title)}</title>`,
        `      <content>${escapeXmlText(annotation.content)}</content>`,
        '    </annotation>',
      ].join('\n');
    })
    .join('\n');
  return [
    `<annotation-result version="2" source="code-review" review-run-id="${escapeXmlAttribute(input.reviewRunId)}" trigger="${input.trigger}" mode="${input.mode}" verdict="${input.verdict}">`,
    `  <summary>${escapeXmlText(input.summary)}</summary>`,
    '  <annotations>',
    annotations,
    '  </annotations>',
    '</annotation-result>',
  ].join('\n');
}

async function readGitBlobRevision(workspace: string, path: string): Promise<`git-blob:${string}`> {
  const { stdout } = await execFileAsync('git', ['rev-parse', `HEAD:${path}`], {
    cwd: workspace,
    encoding: 'utf8',
  });
  const oid = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(oid)) {
    throw new Error(`Invalid Git blob identity for deleted review target: ${path}`);
  }
  return `git-blob:${oid}`;
}

function escapeXmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
