import {
  panelContentWidth,
  renderPanelHeader,
  renderPanelRow,
  renderPanelFooter,
  renderPanelDivider,
  renderPanelBottom,
} from '../widgets/panel-frame.js';
import { decodePrintableKey, matchesKey, VStack, type Component } from '../engine/public.js';
import type { TuiFeatureScreen } from '../shell/surface-host.js';
import { truncateToWidth } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import { TuiSelectionScrollView } from '../widgets/selection-scroll-view.js';
import {
  tuiAgentTeamElapsedMs,
  tuiAgentTeamMemberLabel,
  type TuiAgentTeamMember,
  type TuiAgentTeamSnapshot,
} from './model.js';

export interface TuiAgentTeamPanelOptions {
  readonly snapshot: () => TuiAgentTeamSnapshot;
  readonly activeSessionId: () => string | undefined;
  readonly onSelect: (sessionId: string) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly requestRender: () => void;
}

export class TuiAgentTeamPanel implements TuiFeatureScreen {
  readonly id = 'agent-team';
  readonly layoutRoot: Component;
  private readonly bodyViewport: TuiSelectionScrollView;
  private selectedIndex = 0;
  private selectedSessionId: string | undefined;

  constructor(private readonly options: TuiAgentTeamPanelOptions) {
    const header: Component = {
      render: (width) => this.renderHeader(width),
      invalidate: () => undefined,
    };
    const body: Component = {
      render: (width) => this.renderFramedBody(width),
      invalidate: () => undefined,
    };
    const footer: Component = {
      render: (width) => this.renderFooter(width),
      invalidate: () => undefined,
    };
    this.bodyViewport = new TuiSelectionScrollView(body, {
      primary: true,
      overscroll: 'contain',
    });
    this.layoutRoot = new VStack([
      { component: header, basis: 'auto', shrink: 1, minSize: 1 },
      { component: this.bodyViewport, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
    ]);
  }

  invalidate(): void {
    this.layoutRoot.invalidate();
  }

  handleInput(data: string): void {
    const members = this.options.snapshot().members;
    this.syncSelection(members);
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.options.onCancel();
      return;
    }
    if (members.length === 0) return;
    if (matchesKey(data, 'up')) {
      this.selectedIndex = this.selectedIndex === 0 ? members.length - 1 : this.selectedIndex - 1;
      this.selectedSessionId = members[this.selectedIndex]?.sessionId;
      this.bodyViewport.setActiveRow(this.selectedIndex, true);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, 'down')) {
      this.selectedIndex = (this.selectedIndex + 1) % members.length;
      this.selectedSessionId = members[this.selectedIndex]?.sessionId;
      this.bodyViewport.setActiveRow(this.selectedIndex, true);
      this.options.requestRender();
      return;
    }
    if (matchesKey(data, 'enter')) {
      const selected = members[this.selectedIndex];
      if (selected) void this.options.onSelect(selected.sessionId);
      return;
    }
    const printable = decodePrintableKey(data) ?? data;
    if (printable === 'q' || printable === 'Q') this.options.onCancel();
  }

  render(width: number): string[] {
    return [
      ...this.renderHeader(width),
      ...this.renderFramedBody(width),
      ...this.renderFooter(width),
    ];
  }

  private renderHeader(rawWidth: number): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    if (width === 0) return [];
    const snapshot = this.options.snapshot();
    return [renderPanelHeader(formatHeader(snapshot), undefined, width)].map((line) =>
      truncateToWidth(line, width, ''),
    );
  }

  private renderFramedBody(width: number): string[] {
    const body = this.renderBody(panelContentWidth(width));
    while (body.length < this.bodyViewport.viewportHeight) body.push('');
    return body.map((line) => renderPanelRow(line, width));
  }

  private renderBody(rawWidth: number): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    if (width === 0) return [];
    const snapshot = this.options.snapshot();
    this.syncSelection(snapshot.members);
    this.bodyViewport.setActiveRow(this.selectedIndex);
    if (snapshot.members.length === 0) return [chalk.hex(colors.dim)('No delegated agents')];
    return snapshot.members
      .map((member, index) =>
        renderMember(
          member,
          index === this.selectedIndex,
          snapshot,
          this.options.activeSessionId(),
          width,
        ),
      )
      .map((line) => truncateToWidth(line, width, ''));
  }

  private renderFooter(rawWidth: number): string[] {
    const width = Math.max(0, Math.floor(rawWidth));
    if (width === 0) return [];
    return [
      renderPanelDivider(width),
      ...renderPanelFooter(
        '↑↓ select · PgUp/PgDn scroll · Enter open transcript · Esc return',
        panelContentWidth(width),
      ).map((line) => renderPanelRow(line, width)),
      renderPanelBottom(width),
    ];
  }

  private syncSelection(members: readonly TuiAgentTeamMember[]): void {
    if (members.length === 0) {
      this.selectedIndex = 0;
      this.selectedSessionId = undefined;
      return;
    }
    const selectedSessionId = this.selectedSessionId ?? this.options.activeSessionId();
    const selectedIndex = selectedSessionId
      ? members.findIndex((member) => member.sessionId === selectedSessionId)
      : -1;
    this.selectedIndex =
      selectedIndex >= 0 ? selectedIndex : Math.min(this.selectedIndex, members.length - 1);
    this.selectedSessionId = members[this.selectedIndex]?.sessionId;
    this.bodyViewport.setActiveRow(this.selectedIndex);
  }
}

function formatHeader(snapshot: TuiAgentTeamSnapshot): string {
  const { summary } = snapshot;
  return [
    `Agents · ${String(summary.total)} total`,
    summary.running ? `${String(summary.running)} running` : undefined,
    summary.waiting ? `${String(summary.waiting)} waiting` : undefined,
    summary.queued ? `${String(summary.queued)} queued` : undefined,
    summary.done ? `${String(summary.done)} done` : undefined,
    summary.failed ? `${String(summary.failed)} failed` : undefined,
    summary.stopped ? `${String(summary.stopped)} stopped` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');
}

function renderMember(
  member: TuiAgentTeamMember,
  selected: boolean,
  snapshot: TuiAgentTeamSnapshot,
  activeSessionId: string | undefined,
  width: number,
): string {
  const rail = selected ? chalk.bold.hex(colors.signal)('›') : ' ';
  const name = (selected ? chalk.bold.hex(colors.signal) : chalk.hex(colors.text))(
    tuiAgentTeamMemberLabel(member, snapshot),
  );
  const status = colorStatus(member.status, statusLabel(member.status));
  const current = member.sessionId === activeSessionId ? chalk.hex(colors.signal)('current') : '';
  const elapsed = formatElapsed(tuiAgentTeamElapsedMs(member, snapshot.capturedAtMs));
  const tools = member.toolCount ? `${String(member.toolCount)} tools` : '';
  if (width < 54) {
    return `${rail} ${status} ${chalk.hex(colors.muted)(member.activity)} · ${name}`;
  }
  const task = member.task === member.activity ? '' : member.task;
  return `${rail} ${name} ${status} ${chalk.hex(colors.muted)(
    [member.activity, task].filter(Boolean).join(' · '),
  )} ${chalk.hex(colors.dim)([tools, elapsed, current].filter(Boolean).join(' · '))}`;
}

function statusLabel(status: TuiAgentTeamMember['status']): string {
  if (status === 'done') return 'Done';
  return `${status.charAt(0).toLocaleUpperCase()}${status.slice(1)}`;
}

function colorStatus(status: TuiAgentTeamMember['status'], label: string): string {
  if (status === 'failed') return chalk.hex(colors.error)(label);
  if (status === 'waiting') return chalk.hex(colors.warning)(label);
  if (status === 'done') return chalk.hex(colors.success)(label);
  if (status === 'stopped') return chalk.hex(colors.muted)(label);
  return chalk.hex(colors.accent)(label);
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h`;
}
