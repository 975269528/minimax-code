import type { ChalkInstance } from 'chalk';
import type { GlobalThreadGoal } from '@mavis/shared/global-events';
import { formatTuiDuration } from '../../rendering/duration.js';
import type { Component } from '../../rendering/component.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import { truncateToWidth, visibleWidth } from '../../rendering/text.js';
import { tuiChalk, tuiColors as colors } from '../../theme/runtime.js';

export interface TuiGoalBannerOptions {
  readonly animate?: boolean;
  readonly now?: () => number;
  readonly requestRender?: () => void;
  readonly chalk?: ChalkInstance;
}

const TICK_INTERVAL_MS = 1_000;

export class TuiGoalBanner implements Component {
  private goal: GlobalThreadGoal | undefined;
  private baselineSeconds = 0;
  private baselineAtMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private animationPaused = false;
  private readonly animate: boolean;
  private readonly now: () => number;
  private readonly requestRender: () => void;
  private readonly chalk: ChalkInstance;

  constructor(options: TuiGoalBannerOptions = {}) {
    this.animate = options.animate ?? true;
    this.now = options.now ?? Date.now;
    this.requestRender = options.requestRender ?? (() => undefined);
    this.chalk = options.chalk ?? tuiChalk;
  }

  setGoal(goal: GlobalThreadGoal | undefined): void {
    const now = this.now();
    const continuesActiveGoal =
      goal !== undefined &&
      this.goal !== undefined &&
      goal.goalId === this.goal.goalId &&
      goal.status === 'active' &&
      this.goal.status === 'active';
    const currentSeconds = continuesActiveGoal ? this.elapsedSeconds(now) : 0;

    this.goal = goal;
    this.baselineSeconds = goal
      ? Math.max(goal.timeUsedSeconds, continuesActiveGoal ? currentSeconds : 0)
      : 0;
    this.baselineAtMs = now;
    if (goal?.status === 'active' && this.animate && !this.animationPaused) this.startTimer();
    else this.stopTimer();
    this.requestRender();
  }

  setAnimationPaused(paused: boolean): void {
    if (this.animationPaused === paused) return;
    this.animationPaused = paused;
    if (paused) {
      this.stopTimer();
      return;
    }
    if (this.animate && this.goal?.status === 'active') this.startTimer();
  }

  getGoal(): GlobalThreadGoal | undefined {
    return this.goal;
  }

  invalidate(): void {}

  render(rawWidth: number): string[] {
    const width = normalizeWidth(rawWidth);
    const goal = this.goal;
    if (!goal || goal.status === 'complete' || width === 0) return [];

    const presentation = goalPresentation(goal);
    const elapsed = formatGoalElapsed(this.elapsedSeconds(this.now()));
    const attachment = goal.hasKickoffAttachments ? ' · Attachment' : '';
    let header =
      this.chalk.hex(colors.dim)('  ') +
      this.chalk.bold.hex(presentation.color)('◎ Goal') +
      this.chalk.hex(colors.dim)(' · ') +
      this.chalk.bold.hex(presentation.color)(presentation.label) +
      this.chalk.hex(colors.muted)(` · ${elapsed} active${attachment}`);
    if (visibleWidth(header) > width) {
      header =
        this.chalk.bold.hex(presentation.color)('◎ Goal') +
        this.chalk.hex(colors.dim)(' · ') +
        this.chalk.bold.hex(presentation.color)(presentation.label) +
        this.chalk.hex(colors.muted)(` · ${elapsed}`);
    }
    const policy = goalPolicySummary(goal);
    const verification = latestVerificationSummary(goal.lastVerification);
    const objective = oneLine(goal.objective) || 'Untitled Goal';
    const actions = actionHint(goal.status);
    const lines = [fit(header, width, this.chalk), fit(policy, width, this.chalk)];
    if (verification) lines.push(fit(verification, width, this.chalk));

    if (visibleWidth(`${objective} · ${actions}`) <= width) {
      lines.push(fit(`${objective} · ${actions}`, width, this.chalk));
      return lines;
    }
    lines.push(fit(objective, width, this.chalk), fit(actions, width, this.chalk));
    return lines;
  }

  dispose(): void {
    this.stopTimer();
  }

  private elapsedSeconds(now: number): number {
    if (this.goal?.status !== 'active') return Math.max(0, Math.floor(this.baselineSeconds));
    const liveSeconds = Math.max(0, Math.floor((now - this.baselineAtMs) / 1_000));
    return Math.max(0, Math.floor(this.baselineSeconds + liveSeconds));
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(this.requestRender, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function formatGoalElapsed(rawSeconds: number): string {
  return formatTuiDuration(rawSeconds);
}

export function formatGoalCompletionReceipt(goal: GlobalThreadGoal): string {
  return [
    '✓ Goal complete',
    formatGoalElapsed(goal.timeUsedSeconds),
    `${formatGoalCount(goal.tokensUsed)} tokens`,
    `${formatGoalCount(goal.turnsUsed)} turns`,
  ].join(' · ');
}

export function formatGoalSummary(goal: GlobalThreadGoal): string {
  const lines = [
    `Goal · ${goalPresentation(goal).label}`,
    `Objective: ${oneLine(goal.objective) || 'Untitled Goal'}`,
    `Time used: ${formatGoalElapsed(goal.timeUsedSeconds)}`,
    `${formatGoalCount(goal.tokensUsed)} tokens · ${formatGoalCount(goal.turnsUsed)} turns`,
  ];
  const verification = latestVerificationSummary(goal.lastVerification);
  if (verification) lines.push(verification);
  lines.push(actionHint(goal.status));
  return lines.join('\n');
}

function actionHint(status: GlobalThreadGoal['status']): string {
  if (status === 'active') return '/goal pause · /goal edit · /goal clear';
  if (status === 'complete') {
    return '/goal <objective> starts a new Goal · /goal clear removes this Goal';
  }
  if (status === 'budget_limited') {
    return '/goal clear, then /goal <objective> starts a new Goal';
  }
  if (status === 'paused') {
    return '/goal resume · /goal edit · /goal clear';
  }
  return '/goal resume · /goal edit · /goal clear';
}

function statusPresentation(status: GlobalThreadGoal['status']): {
  readonly label: string;
  readonly color: string;
} {
  if (status === 'active') return { label: 'Active', color: colors.orbit };
  if (status === 'paused') return { label: 'Paused', color: colors.warning };
  if (status === 'blocked') return { label: 'Blocked', color: colors.error };
  if (status === 'complete') return { label: 'Complete', color: colors.success };
  if (status === 'budget_limited') return { label: 'Budget limited', color: colors.warning };
  return { label: 'Usage limited', color: colors.warning };
}

/**
 * An `active` Goal that is parked reads as its wait, not as "Active".
 *
 * This mirrors the Desktop banner rule exactly: the wait replaces the status
 * *label* while the status keeps its own colour, because a wait is an execution
 * detail inside `active` rather than a different lifecycle state. Waits are
 * only meaningful while `active`; the runtime already forces them to null
 * elsewhere, and the status check here keeps that true even for a client fed a
 * stale projection.
 */
function goalPresentation(goal: GlobalThreadGoal): {
  readonly label: string;
  readonly color: string;
} {
  const presentation = statusPresentation(goal.status);
  const wait = goal.status === 'active' ? goal.executionWait : undefined;
  return wait ? { ...presentation, label: WAIT_LABELS[wait.reason] } : presentation;
}

/**
 * Full-key map, deliberately not a partial lookup with a fallback: adding a
 * wait reason to the shared enum must fail this compile rather than silently
 * degrade the TUI to showing "Active" for a Goal that is in fact parked.
 * Wording tracks the Desktop `goal.banner.wait.*` strings.
 */
const WAIT_LABELS: Record<NonNullable<GlobalThreadGoal['executionWait']>['reason'], string> = {
  questionnaire: 'Waiting for your answer',
  permission: 'Waiting for permission',
  plan: 'Waiting for Plan to finish',
  required_background: 'Waiting for background tasks',
  automation_owner_conflict: 'Waiting for automation',
  dependency_unavailable: 'Waiting for a dependency',
  verification: 'Verifying the result',
  unknown: 'Waiting for requirements',
};

function goalPolicySummary(goal: GlobalThreadGoal): string {
  const items = [
    `${formatGoalCount(goal.tokensUsed)} tokens`,
    `${formatGoalCount(goal.turnsUsed)} turns`,
  ];
  if (goal.status === 'usage_limited') items.push('Resume after provider access recovers');
  return items.join(' · ');
}

function latestVerificationSummary(
  verification: GlobalThreadGoal['lastVerification'],
): string | undefined {
  if (!verification) return undefined;
  const items = [`Latest verifier: ${verdictPresentation(verification.verdict)}`];
  if (verification.verdict === 'not_met') {
    items.push(`not-met streak ${Math.max(0, Math.floor(verification.notMetStreak))}`);
    const missing = verification.missing.map(oneLine).filter(Boolean);
    if (missing.length > 0) {
      const visible = missing.slice(0, 2).join('; ');
      const omitted = Math.max(0, missing.length - 2);
      items.push(`missing: ${visible}${omitted > 0 ? ` +${omitted}` : ''}`);
    }
  }
  return items.join(' · ');
}

function verdictPresentation(
  verdict: NonNullable<GlobalThreadGoal['lastVerification']>['verdict'],
): string {
  if (verdict === 'met') return 'Met';
  if (verdict === 'not_met') return 'Not met';
  if (verdict === 'impossible') return 'Impossible';
  return 'Inconclusive';
}

export function formatGoalCount(rawValue: number): string {
  const value = Math.max(0, Math.floor(rawValue));
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${formatCompactCount(value / 1_000)}K`;
  return `${formatCompactCount(value / 1_000_000)}M`;
}

function formatCompactCount(value: number): string {
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * Annotation evidence a Goal objective carries for verification and
 * continuation. The TUI has no annotation UI and shows the objective the user
 * wrote, so the block is dropped here. Tag names mirror the Composer's
 * chat-context contract; the TUI does not depend on the UI package.
 */
const OBJECTIVE_EVIDENCE_RE =
  /<(user-provided-context|mavis-chat-context|html-selection-context|deployed-website-context)\b[^>]*>[\s\S]*?<\/\1>/gu;

function oneLine(value: string): string {
  return sanitizeTerminalText(value.replace(OBJECTIVE_EVIDENCE_RE, ''))
    .replace(/\s+/gu, ' ')
    .trim();
}

function fit(value: string, width: number, chalk: ChalkInstance): string {
  return truncateToWidth(value, width, chalk.hex(colors.dim)('…'));
}

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}
