import type { EvalMetaInfo } from '@mavis/shared/eval-meta-info';

import { logger } from '../common/logger.js';
import {
  buildLocalTrajectoryId,
  buildReportEvalStepBodies,
  collectSensitiveValues,
  describeModel,
  maskText,
  localEvalCaptureLimits,
  safeJsonStringify,
  settleWithin,
  truncateUtf8,
} from './payload.js';
import { buildLocalEvalSnapshotRequest } from './snapshot.js';
import { LocalEvalRuntimeEventBuffer } from './runtime-event-buffer.js';
import {
  uploadLocalEvalRequest,
  readLocalEvalAccessToken,
  collectLocalEvalMetaInfo,
} from './transport.js';
import type {
  EvalReportRequest,
  EvalStep,
  LocalEvalAssistantMessageInput,
  LocalEvalReporterContext,
  LocalEvalReporterFactoryLike,
  LocalEvalReporterFactoryOptions,
  LocalEvalReporterLike,
  LocalEvalRuntimeEventDelivery,
  LocalEvalRuntimeEventInput,
  LocalEvalSnapshotInput,
  LocalEvalToolCallInput,
  LocalEvalToolResultInput,
  LocalEvalTurnFinish,
  LocalEvalTurnStart,
  LocalEvalUsageInput,
  ReporterStepInput,
} from './types.js';

const MAX_BATCH_STEPS = 16;
const MAX_REPORT_BODY_BYTES = 6 << 20;
export class LocalEvalReporterFactory implements LocalEvalReporterFactoryLike {
  private readonly reporters = new Map<string, LocalEvalReporter>();
  private readonly pending = new Set<Promise<void>>();
  private readonly runtimeReporters = new Map<string, LocalEvalReporter>();
  private lastStepSequence = 0;
  private readonly uploadTailBySession = new Map<string, Promise<void>>();
  private readonly runtimeEvents: LocalEvalRuntimeEventBuffer;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;

  constructor(private readonly options: LocalEvalReporterFactoryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
    this.runtimeEvents = new LocalEvalRuntimeEventBuffer(this.nowMs);
  }

  getReporter(context: LocalEvalReporterContext): LocalEvalReporter {
    const existing = this.reporters.get(context.sessionId);
    if (existing) return existing;
    this.runtimeReporters.get(context.sessionId)?.flushPending();
    const reporter = this.createReporter(context);
    this.reporters.set(context.sessionId, reporter);
    return reporter;
  }

  private createReporter(context: LocalEvalReporterContext): LocalEvalReporter {
    const limits = localEvalCaptureLimits(this.options);
    return new LocalEvalReporter(this, context, this.nowMs, limits.stepBytes, limits.snapshotBytes);
  }

  nextStepIndex(timestampMs: number): number {
    const base = timestampMs * 1_000;
    this.lastStepSequence = Math.max(base, this.lastStepSequence + 1);
    return this.lastStepSequence - base;
  }

  releaseRuntimeReporter(sessionId: string, reporter: LocalEvalReporter): void {
    if (this.runtimeReporters.get(sessionId) === reporter) this.runtimeReporters.delete(sessionId);
  }

  releaseReporter(sessionId: string): void {
    const reporter = this.reporters.get(sessionId);
    reporter?.flushPending();
    this.reporters.delete(sessionId);
    this.runtimeEvents.clear(sessionId);
  }
  canReport(): boolean {
    return this.options.enabled && Boolean(readLocalEvalAccessToken(this.options));
  }

  reportRuntimeEvent(
    sessionId: string,
    input: LocalEvalRuntimeEventInput,
  ): LocalEvalRuntimeEventDelivery {
    if (!this.options.enabled) return 'skipped_disabled';
    if (!readLocalEvalAccessToken(this.options)) return 'skipped_no_token';
    if (input.origin) {
      let reporter = this.reporters.get(sessionId) ?? this.runtimeReporters.get(sessionId);
      if (!reporter) {
        // Background observations need no fake Turn or workspace metadata. The timer/flush
        // retires this temporary writer; both active and detached writers share sequences.
        if (this.runtimeReporters.size >= 128)
          this.runtimeReporters.values().next().value?.flushPending();
        reporter = this.createReporter({ sessionId, workspaceDir: '' });
        this.runtimeReporters.set(sessionId, reporter);
      }
      reporter.reportRuntimeEvent(input);
      return 'queued';
    }
    return this.runtimeEvents.report(
      sessionId,
      input,
      (event) => this.reporters.get(sessionId)?.reportRuntimeEvent(event) ?? false,
    );
  }

  drainRuntimeEvents(sessionId: string, reporter: LocalEvalReporter): void {
    reporter.reportBufferedRuntimeEvents(this.runtimeEvents.drain(sessionId));
  }

  enqueue(request: EvalReportRequest, sessionId: string): void {
    if (!this.options.enabled) return;
    if (!readLocalEvalAccessToken(this.options)) return;

    const previous = this.uploadTailBySession.get(sessionId) ?? Promise.resolve();
    const upload = previous.then(() => this.upload(request, sessionId));
    this.uploadTailBySession.set(sessionId, upload);
    this.pending.add(upload);
    void upload.finally(() => {
      this.pending.delete(upload);
      if (this.uploadTailBySession.get(sessionId) === upload) {
        this.uploadTailBySession.delete(sessionId);
      }
    });
  }

  enqueueMetaInfo(reporter: LocalEvalReporter, workspaceDir: string): void {
    const report = collectLocalEvalMetaInfo(this.options, workspaceDir).then((value) => {
      if (!value) return;
      reporter.reportMetaInfo(value);
      reporter.flushPending();
    });
    this.pending.add(report);
    void report.then(
      () => {
        this.pending.delete(report);
      },
      () => {
        this.pending.delete(report);
      },
    );
  }

  async flush(timeoutMs?: number): Promise<void> {
    const boundedTimeoutMs =
      timeoutMs === undefined
        ? undefined
        : Number.isFinite(timeoutMs)
          ? Math.max(0, Math.floor(timeoutMs))
          : 0;
    const deadline = boundedTimeoutMs === undefined ? undefined : Date.now() + boundedTimeoutMs;
    for (const reporter of [...this.reporters.values(), ...this.runtimeReporters.values()])
      reporter.flushPending();
    while (this.pending.size > 0) {
      const pending = [...this.pending];
      if (deadline === undefined) {
        await Promise.all(pending);
      } else {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0 || !(await settleWithin(pending, remainingMs))) {
          logger.warn(
            { pendingCount: this.pending.size, timeoutMs: boundedTimeoutMs },
            '[eval-capture] local eval flush deadline exceeded',
          );
          return;
        }
      }
      for (const reporter of [...this.reporters.values(), ...this.runtimeReporters.values()])
        reporter.flushPending();
    }
  }

  private async upload(request: EvalReportRequest, sessionId: string): Promise<void> {
    const accessToken = readLocalEvalAccessToken(this.options);
    if (!accessToken) return;
    await uploadLocalEvalRequest({
      request,
      sessionId,
      options: this.options,
      fetchImpl: this.fetchImpl,
      accessToken,
    });
  }
}

export class LocalEvalReporter implements LocalEvalReporterLike {
  private readonly trajectoryId: string;
  private readonly sensitiveValues = new Set<string>();
  private pendingSteps: EvalStep[] = [];
  private batchTimer?: ReturnType<typeof setTimeout>;
  private turnId = '';
  private oversizedSnapshotTurnId: string | undefined;
  private targetModel: string | undefined;
  private metaInfoQueued = false;

  constructor(
    private readonly factory: LocalEvalReporterFactory,
    private readonly context: LocalEvalReporterContext,
    private readonly nowMs: () => number,
    private readonly maxStepFieldBytes: number,
    private readonly maxSnapshotBytes: number,
  ) {
    this.trajectoryId = buildLocalTrajectoryId(context.sessionId);
  }

  beginTurn(input: LocalEvalTurnStart): void {
    this.turnId = input.turnId;
    this.oversizedSnapshotTurnId = undefined;
    this.targetModel = describeModel(input.model);
    collectSensitiveValues(input.model, this.sensitiveValues);
    if (input.apiKey && input.apiKey.length >= 6) this.sensitiveValues.add(input.apiKey);

    this.factory.drainRuntimeEvents(this.context.sessionId, this);

    this.reportSteps(
      [
        {
          stepType: 'session_lifecycle',
          role: 'system',
          content: 'turn_started',
          rawJson: safeJsonStringify({ turn_id: input.turnId }, this.sensitiveValues),
        },
        {
          stepType: 'message',
          role: 'user',
          content: maskText(input.userMessage, this.sensitiveValues),
        },
      ],
      true,
    );

    if (!this.metaInfoQueued && this.factory.canReport()) {
      this.metaInfoQueued = true;
      this.factory.enqueueMetaInfo(this, this.context.workspaceDir);
    }
  }

  reportSnapshot(input: LocalEvalSnapshotInput): void {
    if (!this.turnId) return;
    if (this.oversizedSnapshotTurnId === input.turnId) return;
    const clientProducedTs = this.nowMs();
    const targetModel = describeModel(input.model) ?? this.targetModel;
    if (targetModel) this.targetModel = targetModel;
    const snapshot = buildLocalEvalSnapshotRequest({
      trajectoryId: this.trajectoryId,
      sessionId: this.context.sessionId,
      input,
      targetModel,
      clientProducedTs,
      seq: clientProducedTs * 1_000 + this.factory.nextStepIndex(clientProducedTs),
      sensitiveValues: this.sensitiveValues,
      maxBytes: this.maxSnapshotBytes,
    });
    if (snapshot.status === 'oversized') {
      this.oversizedSnapshotTurnId = input.turnId;
      logger.warn(
        {
          sessionId: this.context.sessionId,
          turnId: input.turnId,
          atLeastBytes: snapshot.atLeastBytes,
          maxBytes: this.maxSnapshotBytes,
          messagesCount: input.messages.length,
        },
        '[eval-capture] skipped oversized local snapshot',
      );
      return;
    }
    if (snapshot.status === 'serialization_error') {
      logger.warn(
        {
          sessionId: this.context.sessionId,
          turnId: input.turnId,
          error: snapshot.error.message,
        },
        '[eval-capture] failed to serialize local snapshot request',
      );
      return;
    }
    this.factory.enqueue(snapshot.request, this.context.sessionId);
  }

  reportLifecycle(event: string, details?: Readonly<Record<string, unknown>>): void {
    this.reportSteps([
      {
        stepType: 'session_lifecycle',
        role: 'system',
        content: event,
        ...(details ? { rawJson: safeJsonStringify(details, this.sensitiveValues) } : {}),
      },
    ]);
  }

  reportToolCall(input: LocalEvalToolCallInput): void {
    collectSensitiveValues(input.args, this.sensitiveValues);
    this.reportSteps([
      {
        stepType: 'tool_call',
        role: 'assistant',
        content: input.toolName,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        argsJson: safeJsonStringify(input.args, this.sensitiveValues),
      },
    ]);
  }

  reportToolResult(input: LocalEvalToolResultInput): void {
    collectSensitiveValues(input.result, this.sensitiveValues);
    this.reportSteps([
      {
        stepType: 'tool_result',
        role: 'tool',
        content: input.toolName,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        resultJson: safeJsonStringify(input.result, this.sensitiveValues),
        isError: input.isError,
        ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      },
    ]);
  }

  reportAssistantMessage(input: LocalEvalAssistantMessageInput): void {
    collectSensitiveValues(input.model, this.sensitiveValues);
    if (input.model) this.targetModel = describeModel(input.model) ?? this.targetModel;
    this.reportSteps([
      {
        stepType: 'message',
        role: 'assistant',
        content: maskText(input.content, this.sensitiveValues),
        rawJson: safeJsonStringify(
          {
            stop_reason: input.stopReason,
            error_message: input.errorMessage,
            target_model: this.targetModel,
          },
          this.sensitiveValues,
        ),
      },
    ]);
  }

  reportUsage(input: LocalEvalUsageInput): void {
    collectSensitiveValues(input.model, this.sensitiveValues);
    if (input.model) this.targetModel = describeModel(input.model) ?? this.targetModel;
    this.reportSteps([
      {
        stepType: 'usage',
        role: 'system',
        content: 'model_usage',
        usageJson: safeJsonStringify(input.usage, this.sensitiveValues),
      },
    ]);
  }

  reportRuntimeEvent(input: LocalEvalRuntimeEventInput): boolean {
    if (!this.turnId && !input.origin) return false;
    this.reportRuntimeEvents([input], input.delivery !== 'batched');
    if (input.delivery === 'batched' && this.pendingSteps.length > 0 && !this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushPending(), 1_000);
      this.batchTimer.unref?.();
    }
    return true;
  }

  reportBufferedRuntimeEvents(inputs: readonly LocalEvalRuntimeEventInput[]): void {
    if (!this.turnId || inputs.length === 0) return;
    this.reportRuntimeEvents(inputs, false);
  }

  finishTurn(input: LocalEvalTurnFinish): void {
    this.reportSteps(
      [
        {
          stepType: 'session_lifecycle',
          role: 'system',
          content: `turn_${input.status}`,
          ...(input.error
            ? {
                rawJson: safeJsonStringify({ error: input.error }, this.sensitiveValues),
              }
            : {}),
        },
      ],
      true,
    );
  }

  reportMetaInfo(metaInfo: EvalMetaInfo): void {
    this.reportSteps([
      {
        stepType: 'session_lifecycle',
        role: 'system',
        content: 'meta_info',
        usageJson: safeJsonStringify(
          {
            schema: 'mavis.eval_step.v1',
            kind: 'meta_info',
            meta_info: metaInfo,
          },
          this.sensitiveValues,
        ),
      },
    ]);
  }

  private reportRuntimeEvents(
    inputs: readonly LocalEvalRuntimeEventInput[],
    flushImmediately: boolean,
  ): void {
    this.reportSteps(
      inputs.map((input) => ({
        stepType: 'runtime_event' as const,
        role: 'system',
        content: input.eventType,
        ...(input.isError === undefined ? {} : { isError: input.isError }),
        usageJson: safeJsonStringify(input.payload, this.sensitiveValues),
        ...(input.origin?.toolCallId ? { toolCallId: input.origin.toolCallId } : {}),
      })),
      flushImmediately,
      inputs.every((input) => Boolean(input.origin)),
    );
  }

  private reportSteps(
    inputs: readonly ReporterStepInput[],
    flushImmediately = false,
    independent = false,
  ): void {
    if ((!this.turnId && !independent) || inputs.length === 0) return;
    const steps: EvalStep[] = inputs.map((input) => {
      const timestamp = this.nowMs();
      return {
        ...input,
        content: truncateUtf8(input.content, this.maxStepFieldBytes),
        ...(input.argsJson === undefined
          ? {}
          : { argsJson: truncateUtf8(input.argsJson, this.maxStepFieldBytes) }),
        ...(input.resultJson === undefined
          ? {}
          : { resultJson: truncateUtf8(input.resultJson, this.maxStepFieldBytes) }),
        ...(input.usageJson === undefined
          ? {}
          : { usageJson: truncateUtf8(input.usageJson, this.maxStepFieldBytes) }),
        ...(input.rawJson === undefined
          ? {}
          : { rawJson: truncateUtf8(input.rawJson, this.maxStepFieldBytes) }),
        stepIndex: this.factory.nextStepIndex(timestamp),
        clientProducedTs: timestamp,
      };
    });
    this.pendingSteps.push(...steps);
    if (flushImmediately || this.pendingSteps.length >= MAX_BATCH_STEPS) {
      this.flushPending();
    }
  }

  flushPending(): void {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    this.factory.releaseRuntimeReporter(this.context.sessionId, this);
    if (this.pendingSteps.length === 0) return;
    const steps = this.pendingSteps;
    this.pendingSteps = [];
    const batches = buildReportEvalStepBodies(
      this.trajectoryId,
      steps,
      MAX_BATCH_STEPS,
      MAX_REPORT_BODY_BYTES,
    );
    if (batches.droppedStepIndexes.length > 0) {
      logger.warn(
        {
          sessionId: this.context.sessionId,
          stepIndexes: batches.droppedStepIndexes,
          maxBodyBytes: MAX_REPORT_BODY_BYTES,
        },
        '[eval-capture] skipped eval steps that exceed the upload body budget',
      );
    }
    for (const body of batches.bodies) {
      this.factory.enqueue({ kind: 'steps', body }, this.context.sessionId);
    }
  }
}
