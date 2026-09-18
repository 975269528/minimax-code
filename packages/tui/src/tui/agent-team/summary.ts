import { truncateToWidth } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import {
  selectTuiAgentTeamPreview,
  tuiAgentTeamElapsedMs,
  tuiAgentTeamMemberLabel,
  type TuiAgentTeamMember,
  type TuiAgentTeamSnapshot,
} from './model.js';

export type TuiAgentTeamPresentationStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'resolved'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export function resolveTuiAgentTeamPresentationStatus(
  snapshot: TuiAgentTeamSnapshot,
): TuiAgentTeamPresentationStatus {
  if (snapshot.summary.running > 0 || snapshot.summary.queued > 0) return 'running';
  if (snapshot.summary.waiting > 0) return 'blocked';
  if (snapshot.summary.failed > 0) return 'failed';
  if (snapshot.summary.stopped > 0) return 'cancelled';
  return 'succeeded';
}

export function renderTuiAgentTeamSummary(
  snapshot: TuiAgentTeamSnapshot,
  status: TuiAgentTeamPresentationStatus,
  width: number,
  options: { readonly expanded?: boolean } = {},
): string[] {
  const { summary } = snapshot;
  const counts = [
    `${String(summary.total)} agent${summary.total === 1 ? '' : 's'}`,
    summary.running ? `${String(summary.running)} running` : undefined,
    summary.waiting ? `${String(summary.waiting)} waiting` : undefined,
    summary.queued ? `${String(summary.queued)} queued` : undefined,
    summary.done ? `${String(summary.done)} done` : undefined,
    summary.failed ? `${String(summary.failed)} failed` : undefined,
    summary.stopped ? `${String(summary.stopped)} stopped` : undefined,
  ].filter((value): value is string => Boolean(value));
  const headingMarker =
    status === 'succeeded'
      ? chalk.hex(colors.success)('✓')
      : status === 'failed'
        ? chalk.hex(colors.error)('×')
        : status === 'cancelled'
          ? chalk.hex(colors.muted)('■')
          : status === 'blocked'
            ? chalk.hex(colors.warning)('◉')
            : chalk.hex(colors.accent)('◐');
  const heading = `${headingMarker} ${chalk.bold.hex(colors.text)(
    'Agent team',
  )}${chalk.hex(colors.muted)(` · ${counts.join(' · ')}`)}`;
  const preview = options.expanded ? snapshot.members : selectTuiAgentTeamPreview(snapshot);
  const rows = preview.map((member, index) =>
    renderMember(
      member,
      width,
      index === preview.length - 1 && snapshot.members.length <= preview.length,
      snapshot,
    ),
  );
  const hiddenCount = Math.max(0, snapshot.members.length - preview.length);
  const overflow = hiddenCount
    ? [
        truncateToWidth(
          chalk.hex(colors.dim)(`   └ … ${String(hiddenCount)} more`),
          Math.max(0, width),
          '',
        ),
      ]
    : [];
  return [truncateToWidth(heading, Math.max(0, width), ''), ...rows, ...overflow];
}

function renderMember(
  member: TuiAgentTeamMember,
  width: number,
  last: boolean,
  snapshot: TuiAgentTeamSnapshot,
): string {
  const branch = last ? '└' : '├';
  const marker =
    member.status === 'failed'
      ? chalk.hex(colors.error)('×')
      : member.status === 'waiting'
        ? chalk.hex(colors.warning)('◉')
        : member.status === 'done'
          ? chalk.hex(colors.success)('✓')
          : member.status === 'stopped'
            ? chalk.hex(colors.muted)('■')
            : chalk.hex(colors.accent)('●');
  const status =
    member.status === 'done'
      ? 'Done'
      : `${member.status.charAt(0).toLocaleUpperCase()}${member.status.slice(1)}`;
  const details = [
    status,
    member.activity,
    member.task,
    member.toolCount ? `${String(member.toolCount)} tools` : undefined,
    formatDuration(tuiAgentTeamElapsedMs(member, snapshot.capturedAtMs)),
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(' · ');
  const memberLabel = tuiAgentTeamMemberLabel(member, snapshot);
  const summary =
    width < 48
      ? `${branch} ${marker} ${chalk.hex(colors.muted)(`${status} · ${member.activity}`)} · ${chalk.bold.hex(colors.text)(memberLabel)}`
      : `${branch} ${marker} ${chalk.bold.hex(colors.text)(memberLabel)} ${chalk.hex(colors.muted)(details)}`;
  return truncateToWidth(summary, Math.max(0, width), '');
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(remainingSeconds)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}
