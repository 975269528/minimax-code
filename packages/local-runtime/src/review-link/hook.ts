/**
 * Built-in PostToolUse hook: review-link recorder.
 *
 * When an agent runs `gh pr create|view` or `glab mr create|view` through the
 * bash tool, the vendor CLI prints the review URL. This hook notices that,
 * pairs it with the branch the workspace is on, and records it so the TUI
 * status line can show which pull request or merge request the current branch
 * belongs to.
 *
 * The hook is observation-only: it never rewrites the tool result, never blocks
 * the tool call, and swallows its own failures. A recording that does not
 * happen costs a status line entry, so nothing here is worth failing a turn
 * over.
 *
 * Flow:
 *   Agent calls bash("glab mr create --fill")
 *     → CLI prints "https://gitlab.example.com/group/repo/-/merge_requests/42"
 *     → This hook fires on the Bash PostToolUse
 *     → Resolves the workspace branch via `git rev-parse --abbrev-ref HEAD`
 *     → Records { vendor, url, number, branch, origin } keyed by workspace+branch
 *     → TUI status line renders "!42" on its next refresh
 *
 * The branch is read after the tool call, so only invocations the CLI itself
 * resolved from the current checkout are eligible. `detectReviewCommand` owns
 * that judgement and rejects everything else; see `parse.ts`.
 */

import { homedir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { logger } from '../hooks/engine/host-utils.js';
import { git } from '../files/git-process.js';
import type {
  HookHandler,
  HookRegistration,
  PostToolUseInput,
  PostToolUseOutput,
} from '../hooks/engine/types.js';
import { detectReviewCommand, extractReviewUrl } from './parse.js';
import type { LocalReviewLinkStore } from './store.js';

export const REVIEW_LINK_RECORDER_ID = 'builtin:review-link-recorder';

export interface ReviewLinkRecorderDeps {
  /**
   * Resolves the directory the session's tools actually run in, or
   * `undefined` when unknown. Unknown must skip the recording rather than
   * fall back to a host-wide default: a recording keyed by the wrong
   * directory misattributes the review to another checkout.
   */
  resolveWorkspaceDir: (sessionId: string) => string | undefined | Promise<string | undefined>;
  store: Pick<LocalReviewLinkStore, 'record'>;
  /** Injected for tests; production uses `resolveWorkspaceBranch`. */
  resolveBranch?: (workspaceDir: string) => Promise<string | undefined>;
  nowMs?: () => number;
}

/**
 * Reads the checked-out branch name of a workspace.
 *
 * Returns `undefined` on a detached HEAD (`rev-parse` answers literal `HEAD`)
 * because there is no branch to key the recording by. That is the correct
 * outcome rather than a fallback: a review link recorded against a detached
 * checkout could never be looked up again.
 */
export async function resolveWorkspaceBranch(workspaceDir: string): Promise<string | undefined> {
  const result = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir);
  if (result.code !== 0) return undefined;
  const branch = result.stdout.trim();
  if (!branch || branch === 'HEAD') return undefined;
  return branch;
}

function readCommand(toolArgs: unknown): string | undefined {
  if (!toolArgs || typeof toolArgs !== 'object') return undefined;
  const command = (toolArgs as Record<string, unknown>).command;
  return typeof command === 'string' ? command : undefined;
}

function readResultText(toolResult: unknown): string {
  if (typeof toolResult === 'string') return toolResult;
  // `JSON.stringify` is typed as returning `string`, but at runtime it answers
  // `undefined` for a function or symbol. The tool result is `unknown`, so the
  // fallback keeps this total rather than trusting the declaration.
  return JSON.stringify(toolResult ?? '') ?? '';
}

/**
 * Reports whether a chain of `cd` targets leaves the CLI in the workspace.
 *
 * The chain is folded in order, starting from the workspace, so a relative
 * `cd sub` composes onto whatever the previous `cd` selected and only the final
 * directory is compared. `~` is expanded, and trailing separators are ignored;
 * this is a path comparison, not a filesystem check, so it stays synchronous
 * and cannot fail.
 */
function ranInWorkspace(targets: readonly string[] | undefined, workspaceDir: string): boolean {
  if (!targets || targets.length === 0) return true;
  const workspace = normalize(resolve(workspaceDir));
  const finalDir = targets.reduce((current, target) => {
    const expanded = target.startsWith('~') ? join(homedir(), target.slice(1)) : target;
    return resolve(current, expanded);
  }, workspace);
  return normalize(finalDir) === workspace;
}

export function createReviewLinkRecorderHandler(
  deps: ReviewLinkRecorderDeps,
): HookHandler<PostToolUseInput, PostToolUseOutput> {
  const resolveBranch = deps.resolveBranch ?? resolveWorkspaceBranch;
  const nowMs = deps.nowMs ?? Date.now;

  return async (input, output) => {
    const command = readCommand(input.toolArgs);
    if (!command) return;
    const detected = detectReviewCommand(command);
    // Rejected here when the command text alone rules the invocation out: it
    // named another review, pointed at another repository, or moved the branch
    // after the CLI ran. A named source branch and working directory survive
    // detection and are compared against the checkout below.
    if (!detected) return;

    const parsed = extractReviewUrl(readResultText(input.toolResult), detected.vendor);
    // No URL from this vendor means the CLI did not report a review — a failed
    // create, a `--help`, or output whose review links were too ambiguous to
    // attribute.
    if (!parsed) return;

    try {
      const workspaceDir = await deps.resolveWorkspaceDir(input.sessionId);
      if (!workspaceDir) return;

      // `cd somewhere && gh pr create` only describes this workspace when the
      // directory the CLI ended up in is this workspace. Folding the whole
      // chain matters: `cd /repo && cd /elsewhere` ran the CLI in `/elsewhere`.
      if (!ranInWorkspace(detected.workingDirs, workspaceDir)) return;

      const branch = await resolveBranch(workspaceDir);
      if (!branch) return;

      // An explicit `--head` / `--source-branch` is fine when it names the
      // branch that is actually checked out, and only then.
      if (detected.sourceBranch && detected.sourceBranch !== branch) return;

      const recorded = await deps.store.record(workspaceDir, {
        vendor: parsed.vendor,
        url: parsed.url,
        number: parsed.number,
        branch,
        origin: detected.origin,
        recordedAt: nowMs(),
      });
      if (!recorded) return;

      output.metadata.reviewLinkRecorded = true;
      output.metadata.reviewLinkUrl = recorded.url;
      logger.info(
        `[review-link] recorded ${recorded.vendor} #${recorded.number} branch=${branch} origin=${detected.origin}`,
      );
    } catch (err) {
      // Recording is derived state — never let it surface as a tool failure.
      logger.warn(`[review-link] failed to record: ${(err as Error).message}`);
    }
  };
}

/**
 * Construct the HookRegistration consumed by `HookRegistry.registerBuiltin()`.
 *
 * Priority 60 — after the result-rewriting builtins (10–50) because this hook
 * only observes. Running last keeps it from seeing a result another hook is
 * still about to replace.
 */
export function createReviewLinkRecorderRegistration(
  deps: ReviewLinkRecorderDeps,
): HookRegistration<PostToolUseInput, PostToolUseOutput> {
  return {
    id: REVIEW_LINK_RECORDER_ID,
    hookEvent: 'PostToolUse',
    matcher: '^[Bb]ash$',
    priority: 60,
    timeout: 5_000,
    handler: createReviewLinkRecorderHandler(deps),
  };
}
