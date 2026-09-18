import {
  toPiUserMessage,
  type RunTurnInput,
  type SteeringPollContext,
  type UserMessageInput,
} from '@mavis/agent-core/pi-turn-runner';
import type { ToolExecutionContext } from '@mavis/agent-core/tools';
import {
  emitLocalPluginHookWarnings,
  localPluginHookCoordinator as pluginHookCoordinator,
  renderPluginHookRejectionReminder,
} from '../assembly/local-turn-plugin-hooks.js';
import type { AgentExecutionSnapshot } from '../preparation/contracts.js';
import { isUserSteeringProducer } from '../runner/contracts.js';
import type { AgentHostSteeringMessage, LocalTurnExecutionInput } from '../runner/contracts.js';
import { AgentHostTurnCloseError } from '../runner/turn-close-error.js';
import type {
  LocalRuntimeTurnExecutorOptions,
  LocalRuntimeTurnRunnerInput,
  PreparedSteeringUserMessage,
} from './contracts.js';
import { joinUserPrompt } from './prompt.js';

type PiAgentMessage = NonNullable<RunTurnInput['history']>[number];
const MAX_PLUGIN_STOP_CONTINUATIONS = 8;

export function createContinuationControl(
  input: Pick<
    LocalTurnExecutionInput,
    'lease' | 'control' | 'registerCanonicalUserMessageIds' | 'pluginHooks' | 'session'
  >,
  prepare: (input: AgentHostSteeringMessage) => Promise<PreparedSteeringUserMessage>,
  onConsumed: LocalRuntimeTurnExecutorOptions<
    AgentExecutionSnapshot,
    ToolExecutionContext
  >['onSteeringConsumed'],
): Pick<
  LocalRuntimeTurnRunnerInput,
  'getSteeringMessages' | 'shouldStopAfterSteering' | 'tryBeginClose'
> {
  const { control } = input;
  const hookFollowUps: PiAgentMessage[] = [];
  const pluginStopState: PluginStopState = { active: false, continuationCount: 0 };
  let stopAfterSteering = false;
  return {
    getSteeringMessages: async (context) => {
      const claims = control.drainSteering();
      const messages = claims.flatMap((message) => message.batchMembers ?? [message]);
      // Exit-boundary rule (immediate-send-steering Decision v2): user
      // steering never extends a finished answer. It stays unconsumed so the
      // close that follows an empty poll requeues it as a fresh query, while
      // non-user producers keep injecting into the current turn.
      const deferUserProducers = context?.boundary === 'exit';
      const prepared: PiAgentMessage[] = [];
      const batchId = snapshotBatchId(messages, input.lease.turnId);
      const acceptedUserMessageIds: Array<{
        id: NonNullable<(typeof messages)[number]['userMessageId']>;
        batchId?: string;
      }> = [];
      const consumed = new Set<number>();
      // Deferred entries, a stopping prompt, and every item after it remain
      // unconsumed. Restore them in one FIFO claim ahead of newer arrivals.
      const restoreUnconsumed = (): void => {
        const accepted = new Set(messages.filter((_, index) => consumed.has(index)));
        const unconsumed = claims.filter(
          (claim) => !(claim.batchMembers ?? [claim]).every((message) => accepted.has(message)),
        );
        if (unconsumed.length > 0) control.restoreSteering(unconsumed);
      };
      try {
        for (const [index, message] of messages.entries()) {
          if (deferUserProducers && isUserSteeringProducer(message.producerId)) continue;
          const result = await preparePluginSteeringMessage(input, message, prepare);
          if (result.kind === 'stop') {
            stopAfterSteering = true;
            consumed.clear();
            prepared.length = 0;
            acceptedUserMessageIds.length = 0;
            // The visible runtime warning explains why this turn stopped.
            break;
          }
          consumed.add(index);
          const memberBatchId = result.userBatchMember ? batchId : undefined;
          prepared.push(markBatchMessage(result.message, memberBatchId, message.createdAt));
          if (result.acceptedUserMessageId) {
            acceptedUserMessageIds.push({
              id: result.acceptedUserMessageId,
              batchId: memberBatchId,
            });
          }
        }
        for (const index of consumed) {
          await onConsumed?.({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            message: messages[index]!,
          });
        }
      } catch (error) {
        consumed.clear();
        restoreUnconsumed();
        throw error;
      }
      restoreUnconsumed();
      registerBatchIdentities(input, acceptedUserMessageIds);
      const accepted = new Set(messages.filter((_, index) => consumed.has(index)));
      const completeClaims = claims.filter((claim) =>
        (claim.batchMembers ?? [claim]).every((message) => accepted.has(message)),
      );
      if (completeClaims.length > 0) control.ackSteering(completeClaims);
      return [...hookFollowUps.splice(0), ...prepared];
    },
    shouldStopAfterSteering: () => stopAfterSteering,
    tryBeginClose: (closeContext) => {
      const result = control.tryBeginClose();
      if (result.closed) {
        if (input.pluginHooks?.length) {
          return finishPluginStopAndTrack(input, hookFollowUps, closeContext, pluginStopState);
        }
        pluginHookCoordinator.completeTurn(input.lease.sessionId);
        return true;
      }
      if (result.reason === 'steer-pending') return false;
      throw new AgentHostTurnCloseError(
        result.reason,
        result.reason === 'aborted' ? result.abortReason : undefined,
      );
    },
  };
}

interface PluginStopState {
  active: boolean;
  continuationCount: number;
}

async function finishPluginStopAndTrack(
  input: Pick<LocalTurnExecutionInput, 'lease' | 'pluginHooks' | 'session'>,
  hookFollowUps: PiAgentMessage[],
  closeContext: { readonly lastAssistantMessage?: string },
  state: PluginStopState,
): Promise<boolean> {
  const closed = await finishPluginStop(input, hookFollowUps, {
    stopHookActive: state.active,
    stopContinuationCount: state.continuationCount,
    ...(closeContext.lastAssistantMessage
      ? { lastAssistantMessage: closeContext.lastAssistantMessage }
      : {}),
  });
  if (!closed) {
    state.active = true;
    state.continuationCount += 1;
  }
  return closed;
}

async function preparePluginSteeringMessage(
  input: Pick<
    LocalTurnExecutionInput,
    | 'lease'
    | 'control'
    | 'pluginHooks'
    | 'pluginHookRuntimeContext'
    | 'pluginHookEventReporter'
    | 'session'
  >,
  message: ReturnType<LocalTurnExecutionInput['control']['drainSteering']>[number],
  prepare: (input: AgentHostSteeringMessage) => Promise<PreparedSteeringUserMessage>,
): Promise<
  | { readonly kind: 'stop' }
  | {
      readonly kind: 'continue';
      readonly message: ReturnType<typeof toPiUserMessage>;
      readonly userBatchMember: boolean;
      readonly acceptedUserMessageId?: NonNullable<
        ReturnType<LocalTurnExecutionInput['control']['drainSteering']>[number]['userMessageId']
      >;
    }
> {
  const hookResult = input.pluginHooks?.length
    ? await pluginHookCoordinator.runEvent(
        input.pluginHooks,
        {
          event: 'UserPromptSubmit',
          sessionId: input.lease.sessionId,
          turnId: input.lease.turnId,
          cwd: input.session.workspaceDir,
          ...input.pluginHookRuntimeContext,
          payload: { prompt: message.message.text, source: 'steer' },
        },
        input.lease.signal,
      )
    : undefined;
  if (hookResult) {
    await emitLocalPluginHookWarnings({
      reporter: input.pluginHookEventReporter,
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      event: 'UserPromptSubmit',
      result: hookResult,
      ...(hookResult.decision.continue === false
        ? {
            message:
              hookResult.decision.stopReason ??
              hookResult.decision.reason ??
              'Queued prompt stopped by Plugin Hook.',
          }
        : {}),
    });
  }
  if (hookResult?.decision.continue === false) {
    return { kind: 'stop' };
  }
  if (hookResult?.decision.decision === 'deny') {
    return {
      kind: 'continue',
      message: toPiUserMessage({
        text: renderPluginHookRejectionReminder(hookResult.decision.reason),
      }),
      userBatchMember: false,
      acceptedUserMessageId: undefined,
    };
  }
  const piMessage = await prepareAcceptedPluginSteeringMessage(
    message,
    prepare,
    hookResult?.decision.additionalContext,
  );
  return {
    kind: 'continue',
    message: piMessage,
    userBatchMember: isUserSteeringProducer(message.producerId),
    acceptedUserMessageId: message.userMessageId,
  };
}

async function prepareAcceptedPluginSteeringMessage(
  message: AgentHostSteeringMessage,
  prepare: (input: AgentHostSteeringMessage) => Promise<PreparedSteeringUserMessage>,
  additionalContext: string | undefined,
): Promise<ReturnType<typeof toPiUserMessage>> {
  const prepared = await prepare(message);
  return toPiUserMessage(
    appendPluginHookContext(
      withGenuineQueryProvenance(prepared.userMessage, prepared.genuineUserQueryText),
      additionalContext,
    ),
  );
}

function appendPluginHookContext(
  message: UserMessageInput,
  additionalContext: string | undefined,
): UserMessageInput {
  if (!additionalContext) return message;
  return {
    ...message,
    text: `${message.text}\n\n<plugin-hook-context>\n${additionalContext}\n</plugin-hook-context>`,
  };
}

async function finishPluginStop(
  input: Pick<
    LocalTurnExecutionInput,
    'lease' | 'pluginHooks' | 'pluginHookRuntimeContext' | 'pluginHookEventReporter' | 'session'
  >,
  hookFollowUps: PiAgentMessage[],
  context: {
    readonly stopHookActive: boolean;
    readonly stopContinuationCount: number;
    readonly lastAssistantMessage?: string;
  },
): Promise<boolean> {
  const result = await pluginHookCoordinator.finishTurn({
    handlers: input.pluginHooks ?? [],
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    cwd: input.session.workspaceDir,
    ...input.pluginHookRuntimeContext,
    stopHookActive: context.stopHookActive,
    ...(context.lastAssistantMessage ? { lastAssistantMessage: context.lastAssistantMessage } : {}),
    signal: input.lease.signal,
  });
  await emitLocalPluginHookWarnings({
    reporter: input.pluginHookEventReporter,
    sessionId: input.lease.sessionId,
    turnId: input.lease.turnId,
    event: input.session.parentSessionId ? 'SubagentStop' : 'Stop',
    result,
  });
  const decision = result.decision;
  if (decision.continue === false) {
    pluginHookCoordinator.completeTurn(input.lease.sessionId);
    return true;
  }
  if (decision.continuePrompt) {
    if (context.stopContinuationCount >= MAX_PLUGIN_STOP_CONTINUATIONS) {
      pluginHookCoordinator.completeTurn(input.lease.sessionId);
      return true;
    }
    hookFollowUps.push(toPiUserMessage({ text: decision.continuePrompt }));
    return false;
  }
  pluginHookCoordinator.completeTurn(input.lease.sessionId);
  return true;
}

function markBatchMessage(
  message: ReturnType<typeof toPiUserMessage>,
  batchId: string | undefined,
  timestamp: number | undefined,
): PiAgentMessage {
  return {
    ...message,
    ...(batchId ? { hostMetadata: { immediateSendBatchId: batchId } } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function snapshotBatchId(
  messages: readonly AgentHostSteeringMessage[],
  turnId: string,
): string | undefined {
  const first = messages.find((message) => isUserSteeringProducer(message.producerId));
  return first ? `${turnId}:${first.producerId}:${first.idempotencyKey}` : undefined;
}

function registerBatchIdentities(
  input: Pick<LocalTurnExecutionInput, 'registerCanonicalUserMessageIds'>,
  identities: readonly {
    id: NonNullable<AgentHostSteeringMessage['userMessageId']>;
    batchId?: string;
  }[],
): void {
  for (const identity of identities) {
    if (identity.batchId) input.registerCanonicalUserMessageIds([identity.id], identity.batchId);
    else input.registerCanonicalUserMessageIds([identity.id]);
  }
}

export function prepareInitialImmediateSendBatch(
  input: LocalTurnExecutionInput,
  preparedBatch: {
    readonly messages: readonly UserMessageInput[] | undefined;
    readonly genuineUserQueryTexts: readonly string[] | undefined;
  },
  ordinary: UserMessageInput,
  prefix: string,
): UserMessageInput[] {
  const batch = input.request.immediateSendBatch;
  if (!batch) return [ordinary];
  const { messages: preparedMessages, genuineUserQueryTexts: preparedGenuineUserQueryTexts } =
    preparedBatch;
  if (!preparedMessages || preparedMessages.length !== batch.members.length) {
    throw new TypeError('Initial batch preparation is incomplete.');
  }
  if (
    preparedGenuineUserQueryTexts !== undefined &&
    preparedGenuineUserQueryTexts.length !== batch.members.length
  ) {
    throw new TypeError('Initial batch genuine-user provenance is incomplete.');
  }
  return batch.members.map((member, index) => {
    const prepared = preparedMessages[index]!;
    return withGenuineQueryProvenance(
      {
        ...prepared,
        text: index === 0 ? joinUserPrompt(prefix, '', '', prepared.text) : prepared.text,
        timestamp: member.createdAt,
        hostMetadata: { ...prepared.hostMetadata, immediateSendBatchId: batch.id },
      },
      preparedGenuineUserQueryTexts?.[index] ?? member.genuineUserQueryText,
    );
  });
}

export function withGenuineQueryProvenance(
  input: UserMessageInput,
  genuineUserQueryText: string,
): UserMessageInput {
  const startOffset = input.text.length - genuineUserQueryText.length;
  if (startOffset >= 0 && input.text.slice(startOffset) === genuineUserQueryText) {
    return {
      ...input,
      canonicalTextRange: { startOffset, endOffset: input.text.length },
    };
  }
  return {
    ...input,
    canonicalTextRange: { startOffset: input.text.length, endOffset: input.text.length },
    genuineUserQueryText,
  };
}

/** Pending child Bash keeps the Turn active, so user input must not be deferred to a future Turn. */
export async function resolveChildBashSteeringContext(
  context: SteeringPollContext | undefined,
  childBash: { hasPending(): Promise<boolean> } | undefined,
): Promise<SteeringPollContext | undefined> {
  if (context?.boundary === 'exit' && (await childBash?.hasPending())) {
    return { boundary: 'mid-turn' };
  }
  return context;
}
