import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';
import { isActiveTaskStatus, type BackgroundTask, type TaskQuery } from '@mavis/background-task';

import {
  LocalTaskOutputToolDef,
  LocalTaskQueryToolDef,
  LocalTaskStopToolDef,
  type LocalTaskOutputToolInput,
  type LocalTaskQueryToolInput,
  type LocalTaskStopToolInput,
} from './builtin-defs.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskControlAdapter,
  LocalTaskOutputReadResult,
} from './types.js';

const MAX_TASK_OUTPUT_WAIT_MS = 30_000;

@bindTool(LocalTaskQueryToolDef)
export class LocalTaskQueryTool implements ToolImpl<
  typeof LocalTaskQueryToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalTaskControlAdapter) {}

  async execute(ctx: LocalRuntimeToolContext, input: LocalTaskQueryToolInput): Promise<ToolResult> {
    if (input.task_id) {
      const task = await this.adapter.get(ctx, input.task_id);
      if (!task) return notFound(LocalTaskQueryToolDef.name, input.task_id);
      return ok(LocalTaskQueryToolDef.name, renderTask(task), { task: summarizeTask(task) });
    }

    const query: TaskQuery = {
      ownerSessionId: ctx.sessionId,
      ...(input.status ? { statuses: [input.status] } : {}),
    };
    const result = await this.adapter.list(ctx, query);
    const text =
      result.items.length === 0
        ? 'No local background tasks in this session.'
        : result.items.map(renderTask).join('\n');
    return ok(LocalTaskQueryToolDef.name, text, {
      count: result.items.length,
      tasks: result.items.map(summarizeTask),
      ...(result.nextCursor ? { next_cursor: result.nextCursor } : {}),
    });
  }
}

@bindTool(LocalTaskOutputToolDef)
export class LocalTaskOutputTool implements ToolImpl<
  typeof LocalTaskOutputToolDef.schema,
  LocalRuntimeToolContext
> {
  // A turn's tool instance only needs its latest read, not a growing task/session cache.
  private lastRead?: { key: string; status: BackgroundTask['status']; nextOffset: number };

  constructor(private readonly adapter: LocalTaskControlAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskOutputToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const requestedWaitMs = input.wait_ms;
    const effectiveWaitMs = Math.min(requestedWaitMs ?? 0, MAX_TASK_OUTPUT_WAIT_MS);
    const waitMsClamped =
      requestedWaitMs !== undefined && requestedWaitMs > MAX_TASK_OUTPUT_WAIT_MS;
    const task = await this.adapter.get(ctx, input.task_id);
    if (!task) {
      this.lastRead = undefined;
      return notFound(LocalTaskOutputToolDef.name, input.task_id, {
        effective_wait_ms: effectiveWaitMs,
        wait_ms_clamped: waitMsClamped,
      });
    }

    const read = await this.adapter.readOutput(ctx, input.task_id, {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      waitMs: effectiveWaitMs,
      ...(signal ? { signal } : {}),
    });
    const status = read.status ?? task.status;
    const body = read.content || '(no output yet)';
    const cursor = [
      ...(read.nextOffset === undefined ? [] : [`next_offset="${read.nextOffset}"`]),
      ...(read.truncated === undefined ? [] : [`truncated="${read.truncated}"`]),
      ...(read.timedOut === undefined ? [] : [`timed_out="${read.timedOut}"`]),
    ];
    const receipt = cursor.length === 0 ? '' : `<task_output_cursor ${cursor.join(' ')} />\n`;
    const waitLimitHint =
      signal?.aborted || !waitMsClamped || read.timedOut !== true
        ? ''
        : '<task_output_hint>Your requested wait_ms exceeded 30000 ms and was capped at 30000 ms (30 seconds). This output read reached its wait limit; the background task was not stopped. Use wait_ms=30000 or less for future reads.</task_output_hint>\n';
    const hint = signal?.aborted ? '' : this.pollingHint(ctx, input.task_id, { ...read, status });
    const text = `<task_output status="${status}">\n${receipt}${waitLimitHint}${hint}${body}\n</task_output>`;
    return ok(LocalTaskOutputToolDef.name, text, {
      task_id: input.task_id,
      status,
      effective_wait_ms: effectiveWaitMs,
      wait_ms_clamped: waitMsClamped,
      ...(read.timedOut === undefined ? {} : { timed_out: read.timedOut }),
      ...(read.nextOffset === undefined ? {} : { next_offset: read.nextOffset }),
      ...(read.truncated === undefined ? {} : { truncated: read.truncated }),
      ...(read.summary ? { summary: read.summary } : {}),
    });
  }

  private pollingHint(
    ctx: LocalRuntimeToolContext,
    taskId: string,
    read: LocalTaskOutputReadResult & { status: BackgroundTask['status'] },
  ): string {
    const previous = this.lastRead;
    this.lastRead = undefined;
    if (
      !isActiveTaskStatus(read.status) ||
      read.nextOffset === undefined ||
      !Number.isSafeInteger(read.nextOffset) ||
      read.nextOffset < 0
    ) {
      return '';
    }
    const key = JSON.stringify([ctx.sessionId, ctx.turnId, taskId]);
    this.lastRead = { key, status: read.status, nextOffset: read.nextOffset };
    if (
      previous?.key !== key ||
      previous.status !== read.status ||
      previous.nextOffset !== read.nextOffset ||
      read.timedOut === true
    ) {
      return '';
    }
    const nextRead = JSON.stringify({ task_id: taskId, offset: read.nextOffset, wait_ms: 30_000 });
    return (
      '<task_output_hint>Task status and next_offset are unchanged since the previous read. ' +
      `To wait for new output, use task_output(${nextRead}). ` +
      'offset=0 replays existing output and can return immediately even with wait_ms. ' +
      'Avoid repeated immediate checks; continue independent work and wait for the completion notification when available.</task_output_hint>\n'
    );
  }
}

@bindTool(LocalTaskStopToolDef)
export class LocalTaskStopTool implements ToolImpl<
  typeof LocalTaskStopToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalTaskControlAdapter) {}

  async execute(ctx: LocalRuntimeToolContext, input: LocalTaskStopToolInput): Promise<ToolResult> {
    const task = await this.adapter.stop(ctx, input.task_id, input.reason);
    if (!task) return notFound(LocalTaskStopToolDef.name, input.task_id);
    const text = `<task_stop status="${task.status}">\nStop requested for ${input.task_id}.\n</task_stop>`;
    return ok(LocalTaskStopToolDef.name, text, { task_id: input.task_id, status: task.status });
  }
}

function renderTask(task: BackgroundTask): string {
  const description = task.description ? ` ${task.description}` : '';
  const sessionId = childSessionId(task);
  const mode = executionMode(task);
  const lineage = [
    ...(sessionId ? [`session_id=${sessionId}`] : []),
    ...(task.parentTaskId ? [`parent_task_id=${task.parentTaskId}`] : []),
    ...(mode ? [`execution_mode=${mode}`] : []),
  ];
  const lineageText = lineage.length === 0 ? '' : ` (${lineage.join(' ')})`;
  return `- ${task.taskId} [${task.kind}/${task.status}]${description}${lineageText}`;
}

function summarizeTask(task: BackgroundTask): Record<string, unknown> {
  const sessionId = childSessionId(task);
  const mode = executionMode(task);
  return {
    task_id: task.taskId,
    kind: task.kind,
    status: task.status,
    // Handle recovery after the first receipt scrolled out of context. Only a
    // subagent task that really owns a child Session gets a session handle.
    ...(sessionId ? { session_id: sessionId } : {}),
    parent_task_id: task.parentTaskId ?? null,
    ...(mode ? { execution_mode: mode } : {}),
    ...(task.description ? { description: task.description } : {}),
    ...(task.createdAt ? { created_at: task.createdAt } : {}),
    ...(task.endedAt ? { ended_at: task.endedAt } : {}),
    ...(task.lastError ? { last_error: task.lastError.message } : {}),
  };
}

function childSessionId(task: BackgroundTask): string | undefined {
  if (task.kind !== 'subagent') return undefined;
  const sessionId = task.metadata?.childSessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

function executionMode(task: BackgroundTask): string | undefined {
  const mode = task.metadata?.executionMode;
  return typeof mode === 'string' && mode ? mode : undefined;
}

function ok(toolName: string, text: string, details: Record<string, unknown>): ToolResult {
  return { tool_name: toolName, text, content: [{ type: 'text', text }], details };
}

function notFound(
  toolName: string,
  taskId: string,
  extraDetails: Record<string, unknown> = {},
): ToolResult {
  const text = `<task_error>Local background task not found: ${taskId}</task_error>`;
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: { task_id: taskId, status: 'not_found', ...extraDetails },
    isError: true,
  };
}
