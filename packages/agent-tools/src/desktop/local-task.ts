import { bindTool, type ToolImpl, type ToolResult } from '@mavis/agent-core/tools';

import { LocalTaskToolDef, type LocalTaskToolInput } from './builtin-defs.js';
import { formatLocalTaskParentReport } from './task-verification.js';
import type { LocalRuntimeToolContext, LocalTaskAdapter } from './types.js';
import { withPluginHookCompatibleToolResponse } from '../plugin-hooks/vendor-tool-response.js';

@bindTool(LocalTaskToolDef)
export class LocalTaskTool implements ToolImpl<
  typeof LocalTaskToolDef.schema,
  LocalRuntimeToolContext
> {
  constructor(private readonly adapter: LocalTaskAdapter) {}

  async execute(
    ctx: LocalRuntimeToolContext,
    input: LocalTaskToolInput,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('Operation aborted');
    if (input.run_in_background === true) {
      const started = await this.adapter.startBackground(ctx, input, signal);
      if (started.status !== 'started' || !started.taskId) {
        const errorMessage = started.errorMessage ?? 'Local background task failed to start';
        const text = `<task_error${taskIdAttribute(started.taskId)}${sessionIdAttribute(started.subSessionId)}>${errorMessage}</task_error>`;
        return {
          tool_name: LocalTaskToolDef.name,
          text,
          content: [{ type: 'text', text }],
          details: {
            agent_name: input.agent_name,
            status: started.status,
            ...(started.taskId ? { task_id: started.taskId } : {}),
            ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
            ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
          },
          isError: true,
        };
      }

      const text = `<task_background task_id="${escapeXmlAttribute(started.taskId)}"${sessionIdAttribute(started.subSessionId)}>\nStarted background task ${started.taskId}. The owning conversation will automatically resume when it finishes; use task_query/task_output to inspect it early and task_stop to cancel it.\n</task_background>`;
      const result: ToolResult = {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          status: 'started',
          task_id: started.taskId,
          ...(started.subSessionId ? { sub_session_id: started.subSessionId } : {}),
          ...(started.subTurnId ? { sub_turn_id: started.subTurnId } : {}),
        },
      };
      return started.subSessionId
        ? withPluginHookCompatibleToolResponse(result, {
            status: 'async_launched',
            agentId: started.subSessionId,
            description: input.description,
            prompt: input.prompt,
          })
        : result;
    }

    const run = await this.adapter.runForeground(ctx, input, signal);
    if (run.status !== 'succeeded') {
      const errorMessage = run.errorMessage ?? 'Agent task failed';
      const text = `<task_error${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}>\n${formatLocalTaskParentReport(
        {
          ...run,
          errorMessage,
        },
      )}\n</task_error>`;
      return {
        tool_name: LocalTaskToolDef.name,
        text,
        content: [{ type: 'text', text }],
        details: {
          agent_name: input.agent_name,
          status: run.status,
          ...(run.taskId ? { task_id: run.taskId } : {}),
          ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
          ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
          ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
          requested_agent_name: run.requestedAgentName,
          ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
          ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
          ...(run.verification ? { verification: run.verification } : {}),
          error_message: errorMessage,
        },
        isError: true,
      };
    }

    const text = `<task_result${taskIdAttribute(run.taskId)}${sessionIdAttribute(run.subSessionId)}>\n${formatLocalTaskParentReport(run)}\n</task_result>`;
    const result: ToolResult = {
      tool_name: LocalTaskToolDef.name,
      text,
      content: [{ type: 'text', text }],
      details: {
        agent_name: input.agent_name,
        status: 'succeeded',
        ...(run.taskId ? { task_id: run.taskId } : {}),
        ...(run.subSessionId ? { sub_session_id: run.subSessionId } : {}),
        ...(run.subTurnId ? { sub_turn_id: run.subTurnId } : {}),
        ...(run.eventCount !== undefined ? { event_count: run.eventCount } : {}),
        requested_agent_name: run.requestedAgentName,
        ...(run.resolvedAgentName ? { resolved_agent_name: run.resolvedAgentName } : {}),
        ...(run.finalText !== undefined ? { final_text: run.finalText } : {}),
        ...(run.verification ? { verification: run.verification } : {}),
      },
    };
    return run.subSessionId
      ? withPluginHookCompatibleToolResponse(result, {
          status: 'completed',
          agentId: run.subSessionId,
          content: [{ type: 'text', text: run.finalText ?? '' }],
        })
      : result;
  }
}

/**
 * The first receipt carries both handles: `task_id` drives task_query /
 * task_output / task_stop, `session_id` drives session send.
 */
function taskIdAttribute(taskId: string | undefined): string {
  return taskId ? ` task_id="${escapeXmlAttribute(taskId)}"` : '';
}

function sessionIdAttribute(sessionId: string | undefined): string {
  return sessionId ? ` session_id="${escapeXmlAttribute(sessionId)}"` : '';
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
