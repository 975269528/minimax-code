import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import type { AnnotationTargetResolution, ReviewDiffSide } from './types.js';
import { ReviewTargetError, validateWorkspaceRelativePath } from './target-files.js';

const execFileAsync = promisify(execFile);
const CHANGE_ANCHOR_VERSION = 'review-change-anchor-v1';

export interface ReviewChangeAnchorInput {
  workspace: string;
  path: string;
  startLine: number;
  endLine: number;
  side?: ReviewDiffSide;
}

export interface ResolveReviewChangeAnchorInput extends ReviewChangeAnchorInput {
  expectedRevision: `sha256:${string}`;
}

export interface ReviewChangeAnchor {
  revision: `sha256:${string}`;
  side: ReviewDiffSide;
  startLine: number;
  endLine: number;
}

interface ReviewDiffHunk {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  body: string[];
}

export async function createReviewChangeAnchor(
  input: ReviewChangeAnchorInput,
): Promise<ReviewChangeAnchor> {
  const hunks = await readCurrentDiffHunks(input.workspace, input.path);
  const matching = hunks.filter((hunk) => hunkOverlapsRange(hunk, input));
  if (matching.length !== 1) {
    throw new ReviewTargetError(
      'invalid',
      'Related review change does not identify exactly one diff hunk',
    );
  }
  return buildChangeAnchor(input.path, input.side ?? 'new', matching[0]!);
}

export async function resolveReviewChangeAnchor(
  input: ResolveReviewChangeAnchorInput,
): Promise<AnnotationTargetResolution> {
  let hunks: ReviewDiffHunk[];
  try {
    hunks = await readCurrentDiffHunks(input.workspace, input.path);
  } catch (error) {
    if (error instanceof ReviewTargetError) {
      return {
        status: error.status,
        path: input.path,
        side: input.side ?? 'new',
        message: error.message,
      };
    }
    throw error;
  }
  const side = input.side ?? 'new';
  const matches = hunks
    .map((hunk) => buildChangeAnchor(input.path, side, hunk))
    .filter((anchor) => anchor.revision === input.expectedRevision);
  if (matches.length !== 1) {
    return { status: 'changed', path: input.path, side };
  }
  const match = matches[0]!;
  const unchangedLocation = match.startLine === input.startLine && match.endLine === input.endLine;
  return {
    status: unchangedLocation ? 'current' : 'relocated',
    path: input.path,
    side,
    startLine: match.startLine,
    endLine: match.endLine,
    revision: match.revision,
  };
}

async function readCurrentDiffHunks(
  workspace: string,
  sourcePath: string,
): Promise<ReviewDiffHunk[]> {
  await validateWorkspaceRelativePath(workspace, sourcePath);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--unified=0', '--no-color', '--no-ext-diff', 'HEAD', '--', sourcePath],
      {
        cwd: workspace,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return parseDiffHunks(stdout);
  } catch {
    throw new ReviewTargetError('invalid', 'Unable to read the current Git diff');
  }
}

function parseDiffHunks(diff: string): ReviewDiffHunk[] {
  const lines = diff.split(/\r\n|\n|\r/u);
  const hunks: ReviewDiffHunk[] = [];
  let current: ReviewDiffHunk | undefined;
  for (const line of lines) {
    const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/u);
    if (match) {
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        oldStart,
        oldEnd: oldStart + Math.max(0, oldCount - 1),
        newStart,
        newEnd: newStart + Math.max(0, newCount - 1),
        body: [],
      };
      hunks.push(current);
      continue;
    }
    if (current && !line.startsWith('diff --git ')) {
      current.body.push(line);
    }
  }
  return hunks;
}

function hunkOverlapsRange(
  hunk: ReviewDiffHunk,
  target: {
    side?: ReviewDiffSide;
    startLine: number;
    endLine: number;
  },
): boolean {
  const startLine = target.side === 'old' ? hunk.oldStart : hunk.newStart;
  const endLine = target.side === 'old' ? hunk.oldEnd : hunk.newEnd;
  return target.startLine <= endLine && target.endLine >= startLine;
}

function buildChangeAnchor(
  path: string,
  side: ReviewDiffSide,
  hunk: ReviewDiffHunk,
): ReviewChangeAnchor {
  const encoded = [
    encodePart(CHANGE_ANCHOR_VERSION),
    encodePart(path),
    encodePart(side),
    encodeLines('hunk', hunk.body),
  ].join('');
  return {
    revision: `sha256:${createHash('sha256').update(encoded, 'utf8').digest('hex')}`,
    side,
    startLine: side === 'old' ? hunk.oldStart : hunk.newStart,
    endLine: side === 'old' ? hunk.oldEnd : hunk.newEnd,
  };
}

function encodeLines(section: string, lines: readonly string[]): string {
  return `${encodePart(section)}${lines.length}:${lines.map(encodePart).join('')}`;
}

function encodePart(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}
