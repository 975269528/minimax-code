/**
 * Review-link detection — recognising when an agent turn touched a GitHub pull
 * request or a GitLab merge request through the vendor CLIs.
 *
 * The recorder never queries a git host. It only reads what `gh` / `glab`
 * already printed, which keeps the whole feature free of credentials, network
 * calls and host-specific API shapes. That also means self-hosted GitLab works
 * without any configuration: whatever host the CLI printed is the host we
 * record.
 *
 * Two command families are recognised, mirroring the two ways a session comes
 * to be "about" a review:
 *
 *   - `create` — the session opened the review itself.
 *   - `view`   — the session worked on a review that already existed.
 *
 * Both CLIs print the review URL for these subcommands, so the URL is extracted
 * from the tool output rather than reconstructed from flags.
 *
 * ## Why detection is narrow, and where it stops being a string problem
 *
 * The recording is keyed by the branch checked out in the session workspace,
 * and that branch is read *after* the tool call finishes. So a recording is
 * only sound when the review the CLI reported is the one belonging to that
 * branch in that workspace.
 *
 * Some invocations can be ruled out from the command text alone, because they
 * describe a different review by construction: `glab mr view 312` names another
 * review, `--repo other/repo` points at another project, and a trailing
 * `git switch main` moves the branch out from under the read.
 *
 * The rest cannot. `--head my-branch` and `cd /path/to/workspace` are the
 * normal way an agent spells out what it is already doing, and rejecting them
 * on sight would discard the most common invocation shape. Those two are
 * therefore *captured* rather than judged here, and the caller compares them
 * against the resolved checkout — a mismatch skips the recording, agreement
 * keeps it.
 */

/** Which vendor a recorded review link belongs to. */
export type ReviewLinkVendor = 'github' | 'gitlab';

/** How the session came to be associated with the review. */
export type ReviewLinkOrigin = 'created' | 'viewed';

export interface DetectedReviewCommand {
  vendor: ReviewLinkVendor;
  origin: ReviewLinkOrigin;
  /**
   * Source branch named by `--head` / `--source-branch`, when the invocation
   * gave one.
   *
   * Naming a branch is not itself a problem — agents routinely spell out the
   * branch they are already on. The caller compares it against the resolved
   * checkout and only skips the recording when the two disagree.
   */
  sourceBranch?: string;
  /**
   * Directories the line changed into before the invocation, in order.
   *
   * Same rule: `cd <session workspace> && gh pr create` is the normal shape,
   * so the caller folds these against the session workspace rather than
   * rejecting on sight. Folding rather than reading the first one matters —
   * `cd /repo && cd /elsewhere` leaves the CLI in `/elsewhere`.
   */
  workingDirs?: readonly string[];
}

export interface ParsedReviewUrl {
  vendor: ReviewLinkVendor;
  /** Canonical review URL exactly as the CLI printed it. */
  url: string;
  /** Review number within its project (PR number / MR iid). */
  number: number;
}

/**
 * GitHub pull-request URLs: `https://<host>/<owner>/<repo>/pull/<number>`.
 * The host is not pinned to github.com so GitHub Enterprise keeps working.
 */
const GITHUB_PR_URL = /https?:\/\/[^\s/]+\/[^\s]+?\/pull\/(\d+)\b/gu;

/**
 * GitLab merge-request URLs:
 * `https://<host>/<group>/<project>/-/merge_requests/<iid>`.
 *
 * The `/-/` separator is optional because older GitLab versions (and some
 * proxied setups) emit the legacy path without it.
 */
const GITLAB_MR_URL = /https?:\/\/[^\s/]+\/[^\s]+?\/(?:-\/)?merge_requests\/(\d+)\b/gu;

const VENDOR_URL_PATTERN: Record<ReviewLinkVendor, RegExp> = {
  github: GITHUB_PR_URL,
  gitlab: GITLAB_MR_URL,
};

/**
 * Recognises `gh pr create|view` / `glab mr create|view` at the *start* of a
 * command segment.
 *
 * Anchoring matters: searching the whole line would accept
 * `printf 'gh pr create\nhttps://host/o/r/pull/1\n'`, which executes no CLI at
 * all yet prints something the extractor happily reads as a review.
 */
const REVIEW_INVOCATION = /^(gh\s+pr|glab\s+mr)\s+(create|view)\b/u;

/** A segment that only changes directory, e.g. `cd /repo`. */
const CD_SEGMENT = /^cd\s+("[^"]*"|'[^']*'|[^\s]+)\s*$/u;

/**
 * A branch change *after* the invocation invalidates the branch read that
 * follows it. A branch change *before* it does not: the CLI then resolved the
 * review from that same new branch, which is what gets read.
 */
const BRANCH_MOVED = /^git\s+(?:switch|checkout)\b|^git\s+-C\b/u;

/** Flags that select a different repository than the session workspace. */
const REPO_OVERRIDE = /(^|\s)(-R|--repo)(\s|=|$)/u;

/** Flags naming the review's source branch explicitly. */
const SOURCE_BRANCH_FLAG = /(?:^|\s)(?:--source-branch|--head)(?:=|\s+)("[^"]*"|'[^']*'|[^\s]+)/u;

/**
 * `view` flags that consume the following token as a value.
 *
 * Kept exhaustive for the small `gh pr view` / `glab mr view` surface so a
 * value can never be mistaken for a positional review selector.
 */
const VIEW_VALUE_FLAGS = new Set([
  '-R',
  '--repo',
  '--output',
  '-F',
  '--json',
  '--jq',
  '-q',
  '--template',
  '-t',
]);

/**
 * Splits a bash line into the commands it actually runs.
 *
 * Splitting is quote-aware, so `--title "a && b"` stays one segment and text
 * inside `printf '...'` never looks like a command of its own. A bare `&` is a
 * separator too: `glab mr create & git switch main` backgrounds the CLI and
 * then moves the branch, which is exactly the misattribution the later checks
 * exist to catch.
 */
function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;

    if (quote) {
      current += char;
      if (char === '\\' && quote === '"') {
        const next = command[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        }
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ';' || char === '\n' || char === '&' || char === '|') {
      const doubled = command[index + 1] === char;
      segments.push(current);
      current = '';
      if (doubled) index += 1;
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Locates the segment that invokes a review CLI, and the match describing it.
 *
 * Returning the match with its position keeps the caller from re-running the
 * pattern to recover what was already known.
 */
function findInvocation(
  segments: readonly string[],
): { position: number; match: RegExpExecArray } | undefined {
  for (const [position, segment] of segments.entries()) {
    const match = REVIEW_INVOCATION.exec(segment);
    if (match) return { position, match };
  }
  return undefined;
}

/**
 * Detects whether a bash command line invoked a review-touching CLI subcommand
 * in a way that is safely attributable to the current checkout.
 *
 * Returns `undefined` for every other command — including recognised
 * invocations that name an explicit target — so the hook can bail out before
 * touching the tool output.
 */
export function detectReviewCommand(command: string): DetectedReviewCommand | undefined {
  const segments = splitCommandSegments(command);
  const invocation = findInvocation(segments);
  if (!invocation) return undefined;

  const { position, match } = invocation;
  const [, binary = '', subcommand = ''] = match;
  const vendor: ReviewLinkVendor = binary.startsWith('gh') ? 'github' : 'gitlab';
  const origin: ReviewLinkOrigin = subcommand === 'create' ? 'created' : 'viewed';
  const args = match.input.slice(match[0].length);

  // Only a *trailing* branch change matters; the branch is read after the tool
  // call, so a leading one is already reflected in what gets read.
  if (segments.slice(position + 1).some((later) => BRANCH_MOVED.test(later))) return undefined;

  // A different repository cannot be reconciled with the session workspace
  // without a network call, so it stays rejected outright.
  if (REPO_OVERRIDE.test(args)) return undefined;

  // An explicitly named review is some other review by construction.
  if (origin === 'viewed' && hasPositionalSelector(args)) return undefined;

  const sourceBranch = captureQuotedValue(args, SOURCE_BRANCH_FLAG);

  // Every `cd` that ran before the invocation, in order. `cd /repo && cd sub`
  // leaves the CLI in `/repo/sub`, so the caller folds them rather than
  // trusting the first one.
  const workingDirs = segments
    .slice(0, position)
    .map((earlier) => captureQuotedValue(earlier, CD_SEGMENT))
    .filter((dir): dir is string => dir !== undefined);

  return {
    vendor,
    origin,
    ...(sourceBranch ? { sourceBranch } : {}),
    ...(workingDirs.length > 0 ? { workingDirs } : {}),
  };
}

/**
 * Reads `pattern`'s first capture group, unwrapping shell quoting.
 *
 * Used for both flag values and the target of a bare `cd` segment, so it is
 * named for what it extracts rather than for one of its callers.
 */
function captureQuotedValue(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  const raw = match?.[1];
  if (!raw) return undefined;
  const unquoted =
    (raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))
      ? raw.slice(1, -1)
      : raw;
  return unquoted || undefined;
}

/**
 * Reports whether a `view` invocation names a review explicitly.
 *
 * A bare `glab mr view` resolves the review from the current branch, which is
 * exactly the case worth recording. Any positional token — a number, a URL, or
 * a branch name — means the user asked about some other review.
 */
function hasPositionalSelector(args: string): boolean {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (!token.startsWith('-')) return true;
    // `--flag=value` carries its value inline; a separated value is skipped so
    // it cannot be mistaken for a selector.
    if (!token.includes('=') && VIEW_VALUE_FLAGS.has(token)) index += 1;
  }
  return false;
}

/**
 * Extracts the review URL that `vendor`'s CLI printed for the invocation.
 *
 * Scoped to the invoked vendor: `gh pr view --comments` can echo a GitLab link
 * from a comment body, and picking that over the pull request being viewed
 * would record an unrelated review.
 *
 * When several of the vendor's own review URLs appear, the canonical one is the
 * URL the CLI printed on a line of its own. Without such a line the URL is only
 * accepted when it is unambiguous — guessing between review links is exactly
 * how a wrong link gets persisted.
 */
export function extractReviewUrl(
  output: string,
  vendor: ReviewLinkVendor,
): ParsedReviewUrl | undefined {
  // Copied per call: the shared constants are global regexes, and a global
  // regex carries `lastIndex` between uses.
  const pattern = new RegExp(VENDOR_URL_PATTERN[vendor].source, 'gu');
  const matches = [...output.matchAll(pattern)];

  // Uniqueness is the whole test, at both levels. Two URLs each printed on
  // their own line give no basis for calling either one "the" review — taking
  // whichever came first would persist a related repository's link just as
  // readily as the current one.
  const chosen = onlyItem(matches.filter((match) => isOwnLine(output, match))) ?? onlyItem(matches);
  if (!chosen) return undefined;

  const number = Number(chosen[1]);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { vendor, url: chosen[0], number };
}

/** Returns the single element of `items`, or `undefined` when it is not alone. */
function onlyItem<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** Reports whether a match is the entire content of its line. */
function isOwnLine(output: string, match: RegExpMatchArray): boolean {
  const start = match.index ?? 0;
  const lineStart = output.lastIndexOf('\n', start - 1) + 1;
  const lineEnd = output.indexOf('\n', start);
  const line = output.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
  return line.trim() === match[0];
}
