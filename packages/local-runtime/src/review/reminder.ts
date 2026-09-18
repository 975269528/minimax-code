import type { PreparedReview } from './preparation.js';
import type { ReviewContextDelivery } from './types.js';

export function buildInlineReviewUserMessage(
  prepared: PreparedReview,
  delivery: ReviewContextDelivery = 'full',
): string {
  return [buildInlineReviewReminder(prepared, delivery), '', prepared.request].join('\n');
}

export function buildInlineReviewReminder(
  prepared: PreparedReview,
  delivery: ReviewContextDelivery = 'full',
): string {
  return [
    '<system-reminder>',
    '<code-review-instructions>',
    escapeReminderClosingTags(prepared.reviewPrompt),
    '</code-review-instructions>',
    delivery === 'git-discovery'
      ? buildGitDiscoveryScopeBlock()
      : buildReviewContextBlock(prepared),
    '</system-reminder>',
  ].join('\n');
}

export function buildSubagentReviewUserMessage(prepared: PreparedReview): string {
  return [
    '<system-reminder>',
    buildReviewContextBlock(prepared),
    '</system-reminder>',
    '',
    prepared.request,
  ].join('\n');
}

function buildReviewContextBlock(prepared: PreparedReview): string {
  const runtimeContext = {
    reviewRunId: prepared.context.reviewRunId,
    responseLanguage: prepared.context.responseLanguage,
    revisionStatus: prepared.context.revisionStatus,
    changedFiles: prepared.context.changedFiles
      ? [...prepared.context.changedFiles.values()]
      : undefined,
    warnings: prepared.context.warnings,
  };
  return ['<review-context>', serializeReminderData(runtimeContext), '</review-context>'].join(
    '\n',
  );
}

function buildGitDiscoveryScopeBlock(): string {
  return [
    '<review-scope source="git" manifest="omitted">',
    'The precomputed change manifest is omitted from this Review request.',
    'Inspect the complete local changes relative to HEAD with Git before returning findings.',
    '</review-scope>',
  ].join('\n');
}

function serializeReminderData(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e');
}

function escapeReminderClosingTags(value: string): string {
  return value.replace(
    /<\s*\/\s*(system-reminder|code-review-instructions|review-context|review-scope)\s*>/giu,
    (_match, tag: string) => `&lt;/${tag}&gt;`,
  );
}
