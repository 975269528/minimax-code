import type { TuiBackgroundTask } from '../../runtime/port.js';
import type { TuiAgentTeamSnapshot } from '../agent-team/model.js';
import type { Component } from '../rendering/component.js';
import { truncateToWidth } from '../rendering/text.js';
import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';
import type { TuiTodoItem } from '../todo/model.js';
import type { TuiKeybindingRegistry } from './keybindings.js';
import { TuiTodoPanel } from './todo-panel.js';

interface TaskSection {
  readonly kind: 'todo' | 'work';
  readonly lines: readonly string[];
}

/** Composer-adjacent projection for mutable work that must never rewrite Transcript history. */
export class TuiTaskPanel implements Component {
  private readonly todo: TuiTodoPanel;
  private agentTeam: TuiAgentTeamSnapshot | undefined;
  private backgroundTasks: readonly TuiBackgroundTask[] = [];

  constructor(keybindings?: TuiKeybindingRegistry) {
    this.todo = new TuiTodoPanel(keybindings);
  }

  setItems(items: readonly TuiTodoItem[]): void {
    this.todo.setItems(items);
  }

  setAgentTeam(snapshot: TuiAgentTeamSnapshot): void {
    this.agentTeam = snapshot;
  }

  setBackgroundTasks(tasks: readonly TuiBackgroundTask[]): void {
    this.backgroundTasks = tasks.map((task) => ({ ...task }));
  }

  toggleExpanded(): 'compact' | 'expanded' {
    return this.todo.toggleExpanded();
  }

  invalidate(): void {
    this.todo.invalidate();
  }

  render(width: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth < 4) return [];
    return this.renderSections(safeWidth).flatMap((section) => section.lines);
  }

  renderViewport(width: number, height: number): string[] {
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const safeHeight = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (safeWidth < 4 || safeHeight === 0) return [];
    const sections = this.renderSections(safeWidth).filter((section) => section.lines.length > 0);
    const totalRows = sections.reduce((total, section) => total + section.lines.length, 0);
    if (totalRows <= safeHeight) return sections.flatMap((section) => section.lines);
    const budgets = allocateSectionRows(
      sections.map((section) => section.lines.length),
      safeHeight,
    );
    return sections.flatMap((section, index) =>
      fitTaskSection(section, budgets[index] ?? 0, this.todo.isExpanded()),
    );
  }

  private renderSections(width: number): readonly TaskSection[] {
    return [
      { kind: 'todo', lines: this.todo.render(width) },
      { kind: 'work', lines: this.renderWorkSummary(width) },
    ];
  }

  private renderWorkSummary(width: number): string[] {
    const team = this.agentTeam;
    const activeTeam = team !== undefined && hasActiveAgent(team) ? team : undefined;
    const tasksRequiringAttention = this.backgroundTasks.filter(isTaskVisibleInSummary);
    if (!activeTeam && tasksRequiringAttention.length === 0) return [];
    return [renderWorkHeader(activeTeam, tasksRequiringAttention, width)];
  }
}

function allocateSectionRows(lengths: readonly number[], height: number): number[] {
  const budgets = lengths.map(() => 0);
  let remaining = height;
  for (const [index, length] of lengths.entries()) {
    if (remaining === 0) break;
    if (length === 0) continue;
    budgets[index] = 1;
    remaining -= 1;
  }
  while (remaining > 0) {
    let allocated = false;
    for (const [index, length] of lengths.entries()) {
      if (remaining === 0) break;
      if ((budgets[index] ?? 0) >= length) continue;
      budgets[index] = (budgets[index] ?? 0) + 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  return budgets;
}

function fitTaskSection(
  section: TaskSection,
  height: number,
  todoExpanded: boolean,
): readonly string[] {
  if (height <= 0) return [];
  if (section.lines.length <= height) return section.lines;
  if (section.kind !== 'todo') return section.lines.slice(0, height);
  if (todoExpanded) return section.lines.slice(0, height);
  const summary = section.lines.at(-1);
  if (!summary) return [];
  if (height === 1) return [summary];
  return [...section.lines.slice(0, height - 1), summary];
}

function hasActiveAgent(snapshot: TuiAgentTeamSnapshot): boolean {
  return snapshot.members.some(
    (member) =>
      member.status === 'queued' || member.status === 'running' || member.status === 'waiting',
  );
}

function renderWorkHeader(
  team: TuiAgentTeamSnapshot | undefined,
  tasks: readonly TuiBackgroundTask[],
  width: number,
): string {
  const agentActive = (team?.summary.running ?? 0) + (team?.summary.queued ?? 0);
  const agentWaiting = team?.summary.waiting ?? 0;
  const backgroundActive = tasks.filter((task) => isActiveTask(task.status)).length;
  const failed =
    (team?.summary.failed ?? 0) +
    tasks.filter((task) => task.status === 'failed' || task.status === 'lost').length;
  const ready = tasks.filter((task) => task.status === 'succeeded').length;
  const cancelled =
    (team?.summary.stopped ?? 0) + tasks.filter((task) => task.status === 'canceled').length;
  const counts = [
    failed > 0 ? `${String(failed)} failed` : undefined,
    agentWaiting > 0
      ? `${String(agentWaiting)} agent${agentWaiting === 1 ? '' : 's'} waiting`
      : undefined,
    agentActive > 0
      ? `${String(agentActive)} agent${agentActive === 1 ? '' : 's'} active`
      : undefined,
    backgroundActive > 0 ? `${String(backgroundActive)} background active` : undefined,
    ready > 0 ? `${String(ready)} result${ready === 1 ? '' : 's'} ready` : undefined,
    cancelled > 0 ? `${String(cancelled)} cancelled` : undefined,
  ].filter((value): value is string => Boolean(value));
  const marker =
    failed > 0
      ? chalk.hex(colors.error)('×')
      : agentWaiting > 0 || tasks.some((task) => task.status === 'stopping')
        ? chalk.hex(colors.warning)('◉')
        : agentActive > 0 || backgroundActive > 0
          ? chalk.hex(colors.accent)('◐')
          : cancelled > 0 && ready === 0
            ? chalk.hex(colors.muted)('■')
            : chalk.hex(colors.success)('✓');
  return truncateToWidth(
    `${marker} ${chalk.bold.hex(colors.text)('Tasks')}${chalk.hex(colors.muted)(` · ${counts.join(' · ')} · /tasks details`)}`,
    width,
    '',
  );
}

function isActiveTask(status: TuiBackgroundTask['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'stopping';
}

function isTaskVisibleInSummary(task: TuiBackgroundTask): boolean {
  return isActiveTask(task.status) || task.deliveredAtMs === undefined;
}
