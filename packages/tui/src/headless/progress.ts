import { performance } from 'node:perf_hooks';

import type { TuiStreamEvent, TuiToolCall } from '../runtime/stream-events.js';

/** Projects only allowlisted metadata; never forwards arbitrary event bodies. */
export class ExecProgress {
  private readonly active = new Map<
    string,
    { kind: string; startedAt: number; startedAtMs: number }
  >();
  private readonly toolStates = new Map<string, string>();
  private modelSteps = 0;
  private toolCalls = 0;
  private lastActivityAt = Date.now();
  private droppedOperations = 0;

  constructor(private readonly record: (event: Readonly<Record<string, unknown>>) => void) {}

  observe(event: TuiStreamEvent): void {
    if (event.type === 'delta') {
      if (event.content || event.thinking || event.toolCalls?.length)
        this.lastActivityAt = Date.now();
      for (const tool of event.toolCalls ?? []) this.tool(tool);
    } else if (event.type === 'message') {
      for (const tool of event.message.toolCalls ?? []) this.tool(tool);
    } else if (event.type === 'generic' && event.eventType === 'execution.diagnostic') {
      const { kind, operationId, modelId, protocol, finishReason } = event.data;
      if (typeof operationId !== 'string') return;
      if (kind === 'model_phase_started') {
        this.modelSteps++;
        this.start(operationId, 'model');
      } else if (kind === 'model_phase_finished' || kind === 'model_phase_failed') {
        this.end(operationId, {
          finishReason: typeof finishReason === 'string' ? finishReason : undefined,
        });
      } else return;
      this.record({
        kind,
        operationId,
        modelId: typeof modelId === 'string' ? modelId : undefined,
        protocol: typeof protocol === 'string' ? protocol : undefined,
      });
    }
  }

  summary(): Readonly<Record<string, unknown>> {
    return {
      modelSteps: this.modelSteps,
      toolCalls: this.toolCalls,
      lastActivityAt: this.lastActivityAt,
      droppedOperations: this.droppedOperations,
      unfinishedOperations: [...this.active].map(([operationId, operation]) => ({
        operationId,
        kind: operation.kind,
        startedAtMs: operation.startedAtMs,
        elapsedMs: Math.max(0, performance.now() - operation.startedAt),
      })),
    };
  }

  private tool(tool: TuiToolCall): void {
    if (!tool.id) return;
    const status = String(tool.status).toLowerCase();
    const state = ['1', 'started', 'running', 'in_progress'].includes(status)
      ? 'started'
      : ['2', 'completed', 'succeeded', 'success'].includes(status)
        ? 'finished'
        : ['3', 'failed', 'error'].includes(status)
          ? 'failed'
          : undefined;
    if (!state || this.toolStates.get(tool.id) === state) return;
    if (this.toolStates.size >= 4096 && !this.toolStates.has(tool.id)) {
      this.droppedOperations++;
      return;
    }
    this.toolStates.set(tool.id, state);
    if (state === 'started') {
      this.toolCalls++;
      this.start(tool.id, 'tool');
      this.record({ kind: 'tool_started', operationId: tool.id, toolName: tool.name });
    } else {
      this.end(tool.id, { kind: `tool_${state}`, toolName: tool.name });
    }
  }

  private start(operationId: string, kind: string): void {
    this.lastActivityAt = Date.now();
    if (this.active.size >= 256) {
      this.droppedOperations++;
      return;
    }
    this.active.set(operationId, {
      kind,
      startedAt: performance.now(),
      startedAtMs: this.lastActivityAt,
    });
  }

  private end(operationId: string, metadata: Record<string, unknown>): void {
    this.lastActivityAt = Date.now();
    const operation = this.active.get(operationId);
    this.active.delete(operationId);
    this.record({
      kind: 'operation_finished',
      operationId,
      ...metadata,
      ...(operation
        ? { durationMs: Math.max(0, performance.now() - operation.startedAt) }
        : { missingStart: true }),
    });
  }
}
