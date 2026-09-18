import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  AnnotationTargetResolution,
  ReviewAnchor,
  ReviewChangedRange,
  ReviewDiffSide,
} from './types.js';
import { parseChangedLineRanges } from './preparation.js';
import {
  readSafeGitBaseTextFile,
  readSafeWorkspaceTextFile,
  ReviewTargetError,
  validateWorkspaceRelativePath,
} from './target-files.js';

export {
  createReviewChangeAnchor,
  resolveReviewChangeAnchor,
  type ResolveReviewChangeAnchorInput,
  type ReviewChangeAnchor,
  type ReviewChangeAnchorInput,
} from './change-anchor.js';

const execFileAsync = promisify(execFile);
const ANCHOR_CONTEXT_LINES = 3;
const ANCHOR_VERSION = 'review-line-anchor-v2';

export interface ReviewAnchorInput {
  workspace: string;
  path: string;
  startLine: number;
  endLine: number;
  side?: ReviewDiffSide;
}

export interface ResolveAnnotationTargetInput extends ReviewAnchorInput {
  expectedRevision?: `sha256:${string}`;
  contextBefore?: number;
  contextAfter?: number;
}

export interface ResolveDeletedFileTargetInput {
  workspace: string;
  path: string;
  expectedBlobRevision?: `git-blob:${string}`;
}

export async function createReviewAnchor(input: ReviewAnchorInput): Promise<ReviewAnchor> {
  const file =
    input.side === 'old'
      ? await readSafeGitBaseTextFile(input.workspace, input.path)
      : await readSafeWorkspaceTextFile(input.workspace, input.path);
  const range = normalizeLineRange(input.startLine, input.endLine, file.lines.length);
  const contextBefore = Math.min(ANCHOR_CONTEXT_LINES, range.startLine - 1);
  const contextAfter = Math.min(ANCHOR_CONTEXT_LINES, file.lines.length - range.endLine);
  return buildAnchor({
    path: input.path,
    side: input.side ?? 'new',
    lines: file.lines,
    ...range,
    contextBefore,
    contextAfter,
  });
}

export async function validateReviewTargetPath(
  workspace: string,
  sourcePath: string,
): Promise<void> {
  await validateWorkspaceRelativePath(workspace, sourcePath);
}

export async function resolveDeletedFileTarget(
  input: ResolveDeletedFileTargetInput,
): Promise<AnnotationTargetResolution> {
  try {
    await validateWorkspaceRelativePath(input.workspace, input.path);
    const [{ stdout: statusOutput }, { stdout: blobOutput }] = await Promise.all([
      execFileAsync('git', ['diff', '--name-status', '-z', 'HEAD', '--', input.path], {
        cwd: input.workspace,
        encoding: 'utf8',
      }),
      execFileAsync('git', ['rev-parse', `HEAD:${input.path}`], {
        cwd: input.workspace,
        encoding: 'utf8',
      }),
    ]);
    const blobOid = blobOutput.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(blobOid)) {
      return {
        status: 'invalid',
        targetType: 'file',
        path: input.path,
        message: 'Invalid Git blob identity',
      };
    }
    const blobRevision = `git-blob:${blobOid}` as const;
    if (!statusOutput.startsWith('D\0') && !statusOutput.startsWith('D\t')) {
      return { status: 'changed', targetType: 'file', path: input.path };
    }
    if (input.expectedBlobRevision && input.expectedBlobRevision !== blobRevision) {
      return { status: 'changed', targetType: 'file', path: input.path };
    }
    return {
      status: input.expectedBlobRevision ? 'current' : 'unverified',
      targetType: 'file',
      path: input.path,
      fileState: 'deleted',
      blobRevision,
    };
  } catch (error) {
    if (error instanceof ReviewTargetError) {
      return {
        status: error.status,
        targetType: 'file',
        path: input.path,
        message: error.message,
      };
    }
    return {
      status: 'missing',
      targetType: 'file',
      path: input.path,
      message: 'Deleted review target no longer exists in HEAD',
    };
  }
}

export async function resolveAnnotationTarget(
  input: ResolveAnnotationTargetInput,
): Promise<AnnotationTargetResolution> {
  if (input.side === 'old') {
    return resolveOldAnnotationTarget(input);
  }

  let file: Awaited<ReturnType<typeof readSafeWorkspaceTextFile>>;
  try {
    file = await readSafeWorkspaceTextFile(input.workspace, input.path);
  } catch (error) {
    if (error instanceof ReviewTargetError) {
      return { status: error.status, path: input.path, message: error.message };
    }
    throw error;
  }

  let range: { startLine: number; endLine: number };
  try {
    range = normalizeLineRange(input.startLine, input.endLine, file.lines.length);
  } catch (error) {
    return {
      status: 'invalid',
      path: input.path,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!input.expectedRevision) {
    return {
      status: 'unverified',
      targetType: 'line-range',
      path: input.path,
      side: 'new',
      ...range,
      targetText: targetText(file.lines, range.startLine, range.endLine),
    };
  }

  const contextBefore = normalizeContextCount(input.contextBefore);
  const contextAfter = normalizeContextCount(input.contextAfter);
  const current = buildAnchor({
    path: input.path,
    side: 'new',
    lines: file.lines,
    ...range,
    contextBefore,
    contextAfter,
  });
  if (current.revision === input.expectedRevision) {
    return {
      status: 'current',
      targetType: 'line-range',
      path: input.path,
      side: 'new',
      ...range,
      revision: current.revision,
      contextBefore,
      contextAfter,
      targetText: current.targetText,
    };
  }

  const targetLineCount = range.endLine - range.startLine + 1;
  const matches: Array<{ startLine: number; endLine: number; anchor: ReviewAnchor }> = [];
  for (let startLine = 1; startLine + targetLineCount - 1 <= file.lines.length; startLine += 1) {
    const endLine = startLine + targetLineCount - 1;
    if (startLine - 1 < contextBefore || file.lines.length - endLine < contextAfter) continue;
    const anchor = buildAnchor({
      path: input.path,
      side: 'new',
      lines: file.lines,
      startLine,
      endLine,
      contextBefore,
      contextAfter,
    });
    if (anchor.revision === input.expectedRevision) {
      matches.push({ startLine, endLine, anchor });
    }
  }
  if (matches.length !== 1) {
    return { status: 'changed', path: input.path };
  }
  const match = matches[0]!;
  return {
    status: 'relocated',
    targetType: 'line-range',
    path: input.path,
    side: 'new',
    startLine: match.startLine,
    endLine: match.endLine,
    revision: match.anchor.revision,
    contextBefore,
    contextAfter,
    targetText: match.anchor.targetText,
  };
}

async function resolveOldAnnotationTarget(
  input: ResolveAnnotationTargetInput,
): Promise<AnnotationTargetResolution> {
  let file: Awaited<ReturnType<typeof readSafeGitBaseTextFile>>;
  let ranges: ReviewChangedRange[];
  try {
    file = await readSafeGitBaseTextFile(input.workspace, input.path);
    ranges = await readCurrentDiffRanges(input.workspace, input.path);
  } catch (error) {
    if (error instanceof ReviewTargetError) {
      return {
        status: error.status,
        path: input.path,
        side: 'old',
        message: error.message,
      };
    }
    throw error;
  }

  let range: { startLine: number; endLine: number };
  try {
    range = normalizeLineRange(input.startLine, input.endLine, file.lines.length);
  } catch (error) {
    return {
      status: 'invalid',
      path: input.path,
      side: 'old',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (!overlapsChangedRange(range, 'old', ranges)) {
    return { status: 'changed', path: input.path, side: 'old' };
  }

  if (!input.expectedRevision) {
    return {
      status: 'unverified',
      targetType: 'line-range',
      path: input.path,
      side: 'old',
      ...range,
      targetText: targetText(file.lines, range.startLine, range.endLine),
    };
  }

  const contextBefore = normalizeContextCount(input.contextBefore);
  const contextAfter = normalizeContextCount(input.contextAfter);
  const current = buildAnchor({
    path: input.path,
    side: 'old',
    lines: file.lines,
    ...range,
    contextBefore,
    contextAfter,
  });
  if (current.revision !== input.expectedRevision) {
    return { status: 'changed', path: input.path, side: 'old' };
  }

  return {
    status: 'current',
    targetType: 'line-range',
    path: input.path,
    side: 'old',
    ...range,
    revision: current.revision,
    contextBefore,
    contextAfter,
    targetText: current.targetText,
  };
}

function buildAnchor(input: {
  path: string;
  side: ReviewDiffSide;
  lines: readonly string[];
  startLine: number;
  endLine: number;
  contextBefore: number;
  contextAfter: number;
}): ReviewAnchor {
  if (
    input.startLine - 1 < input.contextBefore ||
    input.lines.length - input.endLine < input.contextAfter
  ) {
    throw new Error('Review anchor context is outside the current file');
  }
  const before = input.lines.slice(input.startLine - 1 - input.contextBefore, input.startLine - 1);
  const target = input.lines.slice(input.startLine - 1, input.endLine);
  const after = input.lines.slice(input.endLine, input.endLine + input.contextAfter);
  const encoded = [
    encodePart(ANCHOR_VERSION),
    encodePart(input.path),
    encodePart(input.side),
    encodeLines('before', before),
    encodeLines('target', target),
    encodeLines('after', after),
  ].join('');
  return {
    revision: `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`,
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
    targetText: target.join('\n'),
  };
}

async function readCurrentDiffRanges(
  workspace: string,
  sourcePath: string,
): Promise<ReviewChangedRange[]> {
  await validateWorkspaceRelativePath(workspace, sourcePath);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--unified=0', '--no-color', 'HEAD', '--', sourcePath],
      {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return parseChangedLineRanges(stdout);
  } catch {
    throw new ReviewTargetError('invalid', 'Unable to read the current Git diff');
  }
}

function overlapsChangedRange(
  target: { startLine: number; endLine: number },
  side: ReviewDiffSide,
  ranges: readonly ReviewChangedRange[],
): boolean {
  return ranges.some(
    (range) =>
      range.side === side && target.startLine <= range.endLine && target.endLine >= range.startLine,
  );
}

function encodeLines(section: string, lines: readonly string[]): string {
  return `${encodePart(section)}${lines.length}:${lines.map(encodePart).join('')}`;
}

function encodePart(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function targetText(lines: readonly string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

function normalizeLineRange(
  startLine: number,
  endLine: number,
  lineCount: number,
): { startLine: number; endLine: number } {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lineCount
  ) {
    throw new Error('Review line range is outside the current file');
  }
  return { startLine, endLine };
}

function normalizeContextCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > ANCHOR_CONTEXT_LINES) {
    throw new Error('Invalid review anchor context');
  }
  return value;
}
