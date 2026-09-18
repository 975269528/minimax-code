import type {
  PiAfterLlmCallHookInput,
  PiBeforeLlmCallHookDecision,
  PiBeforeLlmCallHookInput,
  PiBeforeToolCallHook,
} from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeEvent } from '@mavis/agent-core/protocol';
import type { LocalCodeReviewAdapter } from '@mavis/agent-tools/desktop';
import { logger as defaultLogger } from '../common/logger.js';
import type { LocalSessionRecord } from '../sessions/controller.js';
import { resolveLocalAppMode } from '../runtime/app-mode.js';
import { createReviewActivityIdentity, emitReviewActivity } from './activity-events.js';
import { createReviewAfterLlmHook } from './after-llm-hook.js';
import { ReviewContextAdmission } from './context-admission.js';
import {
  discardReviewPromptRead,
  rememberReviewPromptRead,
  rebindReviewPromptRead,
  reserveReviewPromptRead,
} from './prompt-read-handoff.js';
import { prepareReview, type PreparedReviewRead } from './prompt-preparation.js';
import type { PreparedReview } from './preparation.js';
import { projectReviewRuntimeEvent } from './projection-writer.js';
import {
  inspectReviewProtocolOutput,
  recordReviewProjectionBypass,
} from './protocol-diagnostics.js';
import { buildInlineReviewReminder } from './reminder.js';
import { createReviewToolGuard } from './tool-guard.js';
import { ReviewTurnState } from './turn-state.js';
import type { ReviewContextDelivery } from './types.js';
import { projectReviewResultEvent } from './result-event-projection.js';
import {
  isProjectedReviewResult,
  normalizeSubagentFinalText,
  waitForReviewCompletion,
} from './subagent-result.js';
import type {
  HostedReviewCapabilityOptions,
  HostedReviewIntent,
  HostedReviewPromptInput,
  HostedReviewSubagentResult,
  HostedReviewTurnIdentity,
  StoredReviewTurn,
} from './hosted-capability-contracts.js';

export type {
  HostedReviewIntent,
  HostedReviewPromptInput,
  HostedReviewTurnIdentity,
} from './hosted-capability-contracts.js';

export class HostedReviewCapability {
  private readonly turns = new Map<string, StoredReviewTurn>();
  private readonly contextAdmission: ReviewContextAdmission;

  constructor(private readonly options: HostedReviewCapabilityOptions) {
    this.contextAdmission = new ReviewContextAdmission({
      configGetter: options.configGetter,
      ...(options.remoteCounter ? { remoteCounter: options.remoteCounter } : {}),
      ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
      logger: options.logger ?? defaultLogger,
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    });
  }

  async buildUserPromptPrefix(input: HostedReviewPromptInput): Promise<string | undefined> {
    const trigger = reviewTrigger(input.intent);
    if (!trigger) return undefined;
    const existing = this.turns.get(turnKey(input));
    if (existing?.state.prepared) {
      return existing.state.delivery === 'git-discovery'
        ? existing.state.renderedCompactReminder
        : existing.state.renderedFullReminder;
    }
    const preparedRead = await prepareReview(
      {
        workspace: input.workspaceDir,
        trigger: trigger === 'subagent' ? 'slash' : trigger,
        request: input.userInput,
        ...(trigger === 'subagent' ? { requestedMode: 'inline' as const } : {}),
        ...(input.promptRead ? { promptRead: input.promptRead } : {}),
      },
      this.options,
    );
    const { prepared } = preparedRead;
    const turn = this.getOrCreate(input);
    turn.promptRead = preparedRead.promptRead;
    return this.activateReview(
      turn,
      prepared,
      prepared.mode === 'subagent' ? 'git-discovery' : 'full',
    );
  }

  createCodeReviewAdapter(
    identity: HostedReviewTurnIdentity,
    session: LocalSessionRecord,
  ): LocalCodeReviewAdapter | undefined {
    if (resolveLocalAppMode(session.appMode) !== 'coding' || session.purpose) return undefined;
    const turn = this.getOrCreate({
      ...identity,
      agentName: session.agentName,
      workspaceDir: session.workspaceDir,
      userInput: '',
    });
    return {
      run: async (_ctx, toolInput, signal) => {
        try {
          const preparedRead = await prepareReview(
            {
              workspace: session.workspaceDir,
              trigger: 'natural_language',
              request: toolInput.request,
              ...(toolInput.mode ? { requestedMode: toolInput.mode } : {}),
            },
            this.options,
          );
          const { prepared } = preparedRead;
          turn.promptRead = preparedRead.promptRead;
          const reminder = this.activateReview(
            turn,
            prepared,
            prepared.mode === 'subagent' ? 'git-discovery' : 'full',
          );
          if (prepared.mode === 'inline') {
            return {
              status: 'prepared',
              mode: 'inline',
              instruction: [reminder, '', prepared.request].join('\n'),
            };
          }
          const result = await this.runSubagent(turn, session, preparedRead, signal);
          if (result.status === 'succeeded') {
            turn.state.setSubagentResult(result.finalText);
            return { status: 'succeeded', mode: 'subagent' };
          }
          if (result.status === 'aborted') {
            return { status: 'failed', mode: 'subagent', errorMessage: 'Review was aborted.' };
          }
          const inlinePrepared = { ...prepared, mode: 'inline' as const };
          const inlineReminder = this.activateReview(turn, inlinePrepared, turn.state.delivery);
          return {
            status: 'prepared',
            mode: 'inline',
            instruction: [inlineReminder, '', inlinePrepared.request].join('\n'),
          };
        } catch (error) {
          return {
            status: 'failed',
            mode: toolInput.mode === 'subagent' ? 'subagent' : 'inline',
            errorMessage: error instanceof Error ? error.message : String(error),
          };
        }
      },
    };
  }

  async beforeLlmCall(
    input: PiBeforeLlmCallHookInput,
    identity: HostedReviewTurnIdentity,
  ): Promise<PiBeforeLlmCallHookDecision | undefined> {
    const turn = this.turns.get(turnKey(identity));
    if (!turn?.state.isReviewActivated()) return undefined;
    const ready = turn.state.getSubagentResult();
    if (ready !== undefined) {
      return {
        type: 'respond',
        reason: 'trusted_review_subagent_result',
        text: ready,
      };
    }
    const prepared = turn.state.prepared;
    if (!prepared) return undefined;
    if (prepared.mode === 'inline') {
      return this.contextAdmission.evaluate(input, turn.state, identity);
    }
    await this.ensureActivity(turn, input, identity, prepared);
    const parent = await this.options.conversation?.query.getSession(identity.sessionId);
    if (!parent) {
      await this.settleActivity(turn, input, identity, 'review_failed');
      this.activateReview(turn, { ...prepared, mode: 'inline' }, turn.state.delivery);
      return (
        (await this.contextAdmission.evaluate(input, turn.state, identity)) ?? { type: 'continue' }
      );
    }
    const result = await this.runSubagent(
      turn,
      parent,
      { prepared, promptRead: turn.promptRead },
      input.signal,
    );
    if (result.status === 'aborted') {
      await this.settleActivity(turn, input, identity, 'review_aborted');
      return { type: 'abort', reason: 'review_subagent_aborted' };
    }
    if (result.status === 'failed') {
      await this.settleActivity(turn, input, identity, 'review_failed');
      this.activateReview(turn, { ...prepared, mode: 'inline' }, turn.state.delivery);
      return (
        (await this.contextAdmission.evaluate(input, turn.state, identity)) ?? { type: 'continue' }
      );
    }
    turn.state.setSubagentResult(result.finalText);
    if (!/^\s*<annotation-result\b/iu.test(result.finalText)) {
      await this.settleActivity(turn, input, identity, 'review_failed');
    }
    return {
      type: 'respond',
      reason: 'trusted_review_subagent_result',
      text: result.finalText,
    };
  }

  afterLlmCall(input: PiAfterLlmCallHookInput, identity: HostedReviewTurnIdentity, model?: string) {
    const turn = this.turns.get(turnKey(identity));
    const protocolOutput = inspectReviewProtocolOutput(input);
    if (!turn) {
      if (protocolOutput) {
        recordReviewProjectionBypass({
          identity,
          reasonCode: 'turn_not_found',
          protocolOutput,
          logger: this.options.logger ?? defaultLogger,
          ...(model ? { model } : {}),
        });
      }
      return undefined;
    }
    if (!turn.state.isProjectionActive()) {
      if (protocolOutput) {
        recordReviewProjectionBypass({
          identity,
          reasonCode: 'projection_inactive',
          state: turn.state,
          protocolOutput,
          logger: this.options.logger ?? defaultLogger,
          ...(model ? { model } : {}),
        });
      }
      return undefined;
    }
    if (!turn.state.prepared) {
      if (protocolOutput) {
        recordReviewProjectionBypass({
          identity,
          reasonCode: 'prepared_missing',
          state: turn.state,
          protocolOutput,
          logger: this.options.logger ?? defaultLogger,
          ...(model ? { model } : {}),
        });
      }
      return undefined;
    }
    turn.afterLlmHook ??= createReviewAfterLlmHook(turn.state, {
      ...(this.options.metricsClient ? { metricsClient: this.options.metricsClient } : {}),
      logger: this.options.logger ?? defaultLogger,
      ...(model ? { model } : {}),
    });
    return turn.afterLlmHook(input);
  }

  beforeToolCall(
    input: Parameters<PiBeforeToolCallHook>[0],
    signal: Parameters<PiBeforeToolCallHook>[1],
    identity: HostedReviewTurnIdentity,
  ) {
    const turn = this.turns.get(turnKey(identity));
    if (!turn) return undefined;
    return createReviewToolGuard(turn.state).beforeToolCall(input, signal);
  }

  projectRuntimeEvent(
    identity: HostedReviewTurnIdentity,
    event: RuntimeEvent,
  ): RuntimeEvent | undefined {
    const turn = this.turns.get(turnKey(identity));
    if (!turn) return event;
    const projected = projectReviewRuntimeEvent(event, turn.state) as RuntimeEvent | undefined;
    if (!projected) return projected;
    return projectReviewResultEvent(projected, turn.activity, identity.turnId, turn.state.outcome);
  }

  endTurn(identity: HostedReviewTurnIdentity): void {
    this.turns.delete(turnKey(identity));
  }

  private getOrCreate(input: HostedReviewPromptInput): StoredReviewTurn {
    const key = turnKey(input);
    const current = this.turns.get(key);
    if (current) return current;
    const created = { state: new ReviewTurnState() };
    this.turns.set(key, created);
    return created;
  }

  private activateReview(
    turn: StoredReviewTurn,
    prepared: PreparedReview,
    delivery: ReviewContextDelivery = 'full',
  ): string {
    const fullReminder = buildInlineReviewReminder(prepared, 'full');
    const compactReminder = buildInlineReviewReminder(prepared, 'git-discovery');
    turn.state.activate(prepared, { fullReminder, compactReminder }, delivery);
    return delivery === 'git-discovery' ? compactReminder : fullReminder;
  }
  private async ensureActivity(
    turn: StoredReviewTurn,
    input: PiBeforeLlmCallHookInput,
    identity: HostedReviewTurnIdentity,
    prepared: PreparedReview,
  ): Promise<void> {
    if (turn.activity || !input.eventWriter) return;
    const activity = createReviewActivityIdentity(prepared.context.reviewRunId);
    turn.activity = activity;
    await emitReviewActivity({
      eventWriter: input.eventWriter,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      identity: activity,
      kind: 'review_start',
      timestamp: (this.options.nowMs ?? Date.now)(),
      ...(input.runtimeSeqGenerator ? { runtimeSeq: input.runtimeSeqGenerator() } : {}),
    });
  }

  private async settleActivity(
    turn: StoredReviewTurn,
    input: PiBeforeLlmCallHookInput,
    identity: HostedReviewTurnIdentity,
    kind: 'review_failed' | 'review_aborted',
  ): Promise<void> {
    const activity = turn.activity;
    if (!activity || activity.terminal || !input.eventWriter) return;
    activity.terminal = true;
    await emitReviewActivity({
      eventWriter: input.eventWriter,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      identity: activity,
      kind,
      timestamp: (this.options.nowMs ?? Date.now)(),
      ...(input.runtimeSeqGenerator ? { runtimeSeq: input.runtimeSeqGenerator() } : {}),
    });
  }

  private runSubagent(
    turn: StoredReviewTurn,
    parent: Pick<
      LocalSessionRecord,
      | 'sessionId'
      | 'agentName'
      | 'workspaceDir'
      | 'runLocation'
      | 'appMode'
      | 'effectiveModel'
      | 'effectiveModelVariant'
    >,
    preparedRead: PreparedReviewRead,
    signal?: AbortSignal,
  ): Promise<HostedReviewSubagentResult> {
    if (turn.subagentRun) return turn.subagentRun;
    const run = this.executeSubagent(parent, preparedRead, signal).catch(
      (error): HostedReviewSubagentResult => ({
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }),
    );
    turn.subagentRun = run;
    return run;
  }

  private async executeSubagent(
    parent: Pick<
      LocalSessionRecord,
      | 'sessionId'
      | 'agentName'
      | 'workspaceDir'
      | 'runLocation'
      | 'appMode'
      | 'effectiveModel'
      | 'effectiveModelVariant'
    >,
    preparedRead: PreparedReviewRead,
    signal?: AbortSignal,
  ): Promise<HostedReviewSubagentResult> {
    const conversation = this.options.conversation;
    if (!conversation) return { status: 'failed', errorMessage: 'Conversation is unavailable.' };
    if (signal?.aborted) return { status: 'aborted' };
    const child = await conversation.lifecycle.createSession({
      agentName: parent.agentName,
      workspaceDir: parent.workspaceDir,
      sessionType: 'branch',
      sessionKind: 'task',
      parentSessionId: parent.sessionId,
      title: preparedRead.prepared.responseLanguage === 'zh-CN' ? '代码审查' : 'Code review',
      visibility: 'hidden',
      purpose: `code-review:${preparedRead.prepared.context.reviewRunId}`,
      runLocation: parent.runLocation,
      appMode: parent.appMode,
      ...(parent.effectiveModel !== undefined ? { effectiveModel: parent.effectiveModel } : {}),
      ...(parent.effectiveModelVariant !== undefined
        ? { effectiveModelVariant: parent.effectiveModelVariant }
        : {}),
    });
    const promptReadHandoff = reserveReviewPromptRead(
      preparedRead.promptRead,
      this.options.internalTurnPromptReads?.(),
    );
    if (!promptReadHandoff) {
      return {
        status: 'failed',
        errorMessage: 'Code review prompt snapshot handoff is unavailable.',
      };
    }
    const { requestedTurnId } = promptReadHandoff;
    let registeredTurnId = requestedTurnId;
    const childTurn = this.getOrCreate({
      sessionId: child.sessionId,
      turnId: requestedTurnId,
      agentName: child.agentName,
      workspaceDir: child.workspaceDir,
      userInput: preparedRead.prepared.request,
      intent: {
        kind: 'code-review',
        attributes: { trigger: 'subagent', scope: 'local_changes' },
      },
    });
    this.activateReview(childTurn, { ...preparedRead.prepared, mode: 'inline' }, 'full');
    try {
      rememberReviewPromptRead(promptReadHandoff);
      const accepted = await conversation.ingress.submit({
        sessionId: child.sessionId,
        source: 'code_review',
        allowQueue: false,
        clientRequestId: `review:${preparedRead.prepared.context.reviewRunId}`,
        requestedTurnId,
        message: {
          content: preparedRead.prepared.request,
          displayContent: preparedRead.prepared.displayPrompt,
          origin: {
            review: {
              trigger: 'subagent',
              scope: 'local_changes',
            },
          },
        },
      });
      if (accepted.turnId !== requestedTurnId) {
        rebindReviewPromptRead(promptReadHandoff, accepted.turnId);
        registeredTurnId = accepted.turnId;
      }
      const result = await waitForReviewCompletion(
        conversation,
        child.sessionId,
        accepted.completion,
        signal,
      );
      if (result.status !== 'completed') {
        return result.status === 'aborted'
          ? { status: 'aborted' }
          : { status: 'failed', errorMessage: result.error ?? 'Review subagent failed.' };
      }
      const finalText = [...result.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.text?.trim())
        ?.text?.trim();
      if (!finalText) {
        return { status: 'failed', errorMessage: 'Review subagent returned no final response.' };
      }
      const normalized = normalizeSubagentFinalText(finalText);
      if (!isProjectedReviewResult(normalized)) {
        return {
          status: 'failed',
          errorMessage: 'Review subagent did not return a projected annotation result.',
        };
      }
      return { status: 'succeeded', finalText: normalized };
    } catch (error) {
      discardReviewPromptRead(promptReadHandoff, registeredTurnId);
      throw error;
    }
  }
}

function reviewTrigger(intent: HostedReviewIntent | undefined): 'slash' | 'subagent' | undefined {
  if (intent?.kind !== 'code-review' || intent.attributes?.scope !== 'local_changes') {
    return undefined;
  }
  return intent.attributes.trigger === 'slash' || intent.attributes.trigger === 'subagent'
    ? intent.attributes.trigger
    : undefined;
}

function turnKey(identity: HostedReviewTurnIdentity): string {
  return `${identity.sessionId}\u0000${identity.turnId}`;
}
