import { formatProductTime } from '@mavis/shared/product-time';
import type { TuiSessionInputSummary } from '../../../runtime/port.js';
import { sessionMutationLocale, sessionMutationTemplate, sessionMutationText } from './copy.js';

/**
 * Display-side formatters shared by the session-mutation picker and preview
 * panels. These helpers operate on the TUI-owned summaries returned by the
 * Runtime port; they intentionally do not call into Runtime code so the panels
 * can stay independent from the rewind executor.
 */

export const PROMPT_HEAD_DISPLAY_LIMIT = 48;

export interface FormatTimestampOptions {
  /** Caller-supplied current time so panel rendering stays deterministic in tests. */
  readonly nowMs: number;
  readonly locale?: string;
}

export function formatRelativeTimestamp(
  timestampMs: number,
  nowMs: number,
  locale?: string,
): string {
  const resolvedLocale = locale ?? sessionMutationLocale();
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return sessionMutationText('sessionMutation.format.unknownTime', resolvedLocale);
  }
  return (
    formatProductTime(timestampMs, {
      preset: 'community-relative',
      nowMs,
      locale: resolvedLocale,
    }) || sessionMutationText('sessionMutation.format.unknownTime', resolvedLocale)
  );
}

export function formatPromptHead(head: string | undefined, maxWidth: number): string {
  const limit = Math.max(8, Math.floor(maxWidth));
  const normalized = (head ?? '').replace(/\s+/gu, ' ').trim();
  if (!normalized) return sessionMutationText('sessionMutation.format.noPrompt');
  const codePoints = [...normalized];
  if (codePoints.length <= limit) return normalized;
  // Reserve a single character for the ellipsis so the row stays predictable.
  const slice = codePoints
    .slice(0, Math.max(0, limit - 1))
    .join('')
    .trimEnd();
  return `${slice}\u2026`;
}

export function summarizeFileChangeCount(count: number, locale = sessionMutationLocale()): string {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const key =
    safeCount === 1 ? 'sessionMutation.format.files.one' : 'sessionMutation.format.files.many';
  return sessionMutationTemplate(key, { count: safeCount }, locale);
}

export interface SessionInputSummaryLabel {
  /** Title suitable for the SelectList primary column (prompt head, truncated). */
  readonly title: string;
  /** Description suitable for the SelectList description column. */
  readonly subtitle: string;
}

export interface FormatSessionInputSummaryLabelOptions extends FormatTimestampOptions {
  /** Max width for the prompt head; defaults to {@link PROMPT_HEAD_DISPLAY_LIMIT}. */
  readonly promptMaxWidth?: number;
  /** Number of completed user turns removed when rewinding to this boundary. */
  readonly affectedTurnCount?: number;
}

export function formatSessionInputSummaryLabel(
  summary: TuiSessionInputSummary,
  options: FormatSessionInputSummaryLabelOptions,
): SessionInputSummaryLabel {
  const promptMaxWidth = options.promptMaxWidth ?? PROMPT_HEAD_DISPLAY_LIMIT;
  const title = formatPromptHead(summary.contentHead, promptMaxWidth);
  const parts: string[] = [];
  const locale = options.locale ?? sessionMutationLocale();
  parts.push(summarizeFileChangeCount(summary.fileChangeCount, locale));
  parts.push(formatRelativeTimestamp(summary.timestamp, options.nowMs, locale));
  if (options.affectedTurnCount !== undefined) {
    const count = Math.max(1, Math.floor(options.affectedTurnCount));
    parts.push(
      sessionMutationTemplate(
        count === 1
          ? 'sessionMutation.format.affected.one'
          : 'sessionMutation.format.affected.many',
        { count },
        locale,
      ),
    );
  }
  if (summary.assistantMessageId) {
    parts.push(sessionMutationText('sessionMutation.format.assistantReplied', locale));
  }
  return { title, subtitle: parts.join(' \u00b7 ') };
}

export type RewindFileAction = 'modified' | 'created' | 'deleted' | string;

export interface RewindFileBadge {
  readonly status: 'ready' | 'skipped';
  readonly action: RewindFileAction;
  /** Pre-formatted, sanitized action label (lowercased for stable display). */
  readonly actionLabel: string;
}

export function describeRewindFileAction(file: {
  readonly action: string;
  readonly skipped: boolean;
}): RewindFileBadge {
  const action = (file.action ?? '').trim();
  const actionLabel = knownActionLabel(action) ?? action.toLocaleLowerCase();
  return {
    status: file.skipped ? 'skipped' : 'ready',
    action,
    actionLabel,
  };
}

function knownActionLabel(action: string): string | undefined {
  if (action === 'modified' || action === 'created' || action === 'deleted') {
    return sessionMutationText(`sessionMutation.format.action.${action}`);
  }
  if (!action) return sessionMutationText('sessionMutation.format.action.unknown');
  return undefined;
}
