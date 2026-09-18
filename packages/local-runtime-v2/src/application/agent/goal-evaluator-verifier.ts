import {
  createEvaluatorVerifierAdapter,
  EvaluatorModelCallError,
  VerificationDispatchError,
  type EvaluatorModelCallInput,
  type EvaluatorModelCallResult,
  type EvaluatorModelPort,
  type EvaluatorRouteIdentity,
  type VerificationAttempt,
  type VerificationUsage,
  type VerifierPort,
} from '@mavis/goal';
import { GOAL_CONFIG_DEFAULTS, resolveModelCallRoute } from '@mavis/config';
import { isContextOverflow, streamSimple, type AssistantMessage } from '@earendil-works/pi-ai';

import {
  parseSourceQualifiedModelKey,
  resolveLegacyMinimaxModel,
  type LocalConversationRuntimeConfig,
  type LocalResolvedModelConfig,
} from '../../service/model-system/index.js';
import {
  isTaskSession,
  summarizeCommittedPiGoalUsage,
  type SessionRecord,
} from '../../service/session-system/index.js';
import {
  buildLocalTurnPayloadTransform,
  type AgentExecutionSnapshot,
  type ProductionAgentPreparation,
  type ProductionAgentProductCapabilities,
} from '../../service/turn-system/index.js';

export interface GoalEvaluatorVerifierOptions {
  readonly sessions: {
    getExecutionSnapshot(sessionId: string): Promise<SessionRecord | undefined>;
  };
  readonly agents: ProductionAgentProductCapabilities['agents'];
  readonly preparation: ProductionAgentPreparation;
  readonly config: () => LocalConversationRuntimeConfig;
  readonly tuiProductPolicy?: boolean;
  readonly nowMs?: () => number;
}

/**
 * Bridges the v1 Goal owner to one fresh v2 model request. Model resolution and
 * credentials remain owned by the same production preparation path as worker Turns.
 */
export function createGoalEvaluatorVerifier(options: GoalEvaluatorVerifierOptions): VerifierPort {
  return {
    async dispatch(attempt, signal) {
      const config = options.config();
      const policy = config.goal?.evaluator;
      if (policy && policy.modelPolicy !== 'same-route-small-fast') {
        throw routeUnavailable('The configured Goal evaluator model policy is unsupported.');
      }
      const model = await resolveEvaluatorModelPort(options, config, attempt);
      return createEvaluatorVerifierAdapter({
        model,
        maxTokens: Math.min(
          positiveInteger(attempt.maxTokens, GOAL_CONFIG_DEFAULTS.evaluator.maxTokens),
          positiveInteger(policy?.maxTokens, GOAL_CONFIG_DEFAULTS.evaluator.maxTokens),
        ),
        timeoutSeconds: positiveInteger(
          policy?.timeoutSeconds,
          GOAL_CONFIG_DEFAULTS.evaluator.timeoutSeconds,
        ),
        maxRetries: nonNegativeInteger(
          policy?.maxRetries,
          GOAL_CONFIG_DEFAULTS.evaluator.maxRetries,
        ),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      }).dispatch(attempt, signal);
    },
  };
}

async function resolveEvaluatorModelPort(
  options: GoalEvaluatorVerifierOptions,
  config: LocalConversationRuntimeConfig,
  attempt: VerificationAttempt,
): Promise<EvaluatorModelPort> {
  const worker = parseSourceQualifiedModelKey(attempt.workerModelKey);
  try {
    const candidate = resolveEvaluatorModelSelection(config);
    if (!worker || !candidate) {
      throw routeUnavailable('The worker or small-fast evaluator model identity is unavailable.');
    }
    const workerRoute = routeIdentity(config, worker.providerId);
    const evaluatorRoute = routeIdentity(config, candidate.providerId);
    if (!sameDataRoute(workerRoute, evaluatorRoute)) {
      throw routeUnavailable('The configured small-fast model is not on the worker data route.');
    }
    const session = await options.sessions.getExecutionSnapshot(attempt.sessionId);
    if (!session) throw new Error(`Evaluator Session not found: ${attempt.sessionId}`);
    const agent = await getSessionAgentSnapshot(options.agents, session);
    if (!agent) throw new Error(`Evaluator Agent not found: ${session.agentName}`);
    const agentConfig = await options.preparation.buildAgentConfig({
      session,
      agent,
      model: {
        provider_id: candidate.providerId,
        model_id: candidate.modelId,
        thinking: {},
      },
      isSessionFirstTurn: false,
    });
    const llm = await options.preparation.resolveModel({
      sessionId: attempt.sessionId,
      turnId: `${attempt.turnId}:goal-evaluator`,
      agentConfig,
    });
    return {
      workerRoute,
      evaluatorRoute,
      call: (input) =>
        callEvaluatorModel({
          input,
          agentConfig: { ...agentConfig },
          llm,
          nowMs: options.nowMs,
        }),
    };
  } catch (error) {
    if (error instanceof VerificationDispatchError) throw error;
    throw routeUnavailable(
      'The same-route small-fast evaluator model could not be resolved.',
      error,
    );
  }
}

function resolveEvaluatorModelSelection(config: LocalConversationRuntimeConfig) {
  const configured = parseSourceQualifiedModelKey(config.defaultLightModel ?? config.defaultModel);
  if (!configured) return configured;
  return resolveLegacyMinimaxModel(config, configured) ?? configured;
}

async function callEvaluatorModel(input: {
  readonly input: EvaluatorModelCallInput;
  readonly agentConfig: Readonly<Record<string, unknown>>;
  readonly llm: LocalResolvedModelConfig;
  readonly nowMs?: () => number;
}): Promise<EvaluatorModelCallResult> {
  const { llm } = input;
  if (input.input.images?.length && !llm.model.input.includes('image')) {
    throw new EvaluatorModelCallError(
      'api_error',
      'The configured Goal evaluator model does not support screenshot input.',
      0,
      false,
    );
  }
  const requestPayloadTransform = buildLocalTurnPayloadTransform(input.agentConfig, {
    thinkingLevel: 'off',
    ...(llm.thinkingRequestPatch ? { thinkingRequestPatch: llm.thinkingRequestPatch } : {}),
    signal: input.input.signal,
  });
  try {
    const final = await requestEvaluatorModel(input, requestPayloadTransform);
    return evaluateFinalMessage(final, llm.model.contextWindow, input.input.signal);
  } catch (error) {
    throw classifyEvaluatorCallError(input.input.signal, error);
  }
}

async function requestEvaluatorModel(
  input: Parameters<typeof callEvaluatorModel>[0],
  requestPayloadTransform: ReturnType<typeof buildLocalTurnPayloadTransform>,
): Promise<AssistantMessage> {
  const response = await (input.llm.streamFn ?? streamSimple)(
    input.llm.model,
    {
      systemPrompt: input.input.systemPrompt,
      messages: [
        {
          role: 'user',
          content: input.input.images?.length
            ? [
                { type: 'text', text: input.input.userPrompt },
                ...input.input.images.map((image) => ({ type: 'image' as const, ...image })),
              ]
            : input.input.userPrompt,
          timestamp: (input.nowMs ?? Date.now)(),
        },
      ],
      tools: [...input.input.tools],
    },
    {
      ...(input.llm.apiKey ? { apiKey: input.llm.apiKey } : {}),
      ...(input.llm.headers ? { headers: { ...input.llm.headers } } : {}),
      maxTokens: input.input.maxTokens,
      timeoutMs: input.input.timeoutMs,
      maxRetries: 0,
      signal: input.input.signal,
      onPayload: requestPayloadTransform,
    },
  );
  return response.result();
}

function classifyEvaluatorCallError(signal: AbortSignal, error: unknown): Error {
  // The adapter owns the distinction between its parent AbortSignal and its
  // private timeout signal. Preserve an untyped abort so it can classify it.
  if (signal.aborted) return abortReason(signal, error);
  if (error instanceof EvaluatorModelCallError) return error;
  if (isExplicitInputTooLargeError(error)) {
    return new EvaluatorModelCallError(
      'input_too_large',
      'Evaluator input exceeded the model context window.',
      null,
      true,
      { cause: error },
    );
  }
  return new EvaluatorModelCallError(
    'api_error',
    error instanceof Error ? error.message : 'Evaluator model request failed.',
    null,
    true,
    { cause: error },
  );
}

function evaluateFinalMessage(
  final: AssistantMessage,
  contextWindow: number,
  signal: AbortSignal,
): EvaluatorModelCallResult {
  const usage = summarizeCommittedPiGoalUsage([final]);
  const tokens = usage.incomplete ? null : usage.tokens;
  if (isFinalContextOverflow(final, contextWindow)) {
    throw new EvaluatorModelCallError(
      'input_too_large',
      final.errorMessage ?? 'Evaluator input exceeded the model context window.',
      tokens,
      usage.incomplete,
    );
  }
  if (signal.aborted) throw abortReason(signal, final.errorMessage);
  if (final.stopReason === 'aborted') {
    throw new EvaluatorModelCallError(
      'aborted',
      final.errorMessage ?? 'Evaluator model request was aborted.',
      tokens,
      usage.incomplete,
    );
  }
  if (final.stopReason === 'error' || final.stopReason === 'toolUse') {
    throw new EvaluatorModelCallError(
      'api_error',
      final.errorMessage ?? `Evaluator model stopped with ${final.stopReason}.`,
      tokens,
      usage.incomplete,
    );
  }
  return {
    text: final.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(''),
    tokens,
    incomplete: usage.incomplete,
  };
}

function isFinalContextOverflow(final: AssistantMessage, contextWindow: number): boolean {
  const usage = Reflect.get(final, 'usage');
  if (usage && typeof usage === 'object') return isContextOverflow(final, contextWindow);
  return final.stopReason === 'error' && isExplicitInputTooLargeError(final.errorMessage);
}

function routeIdentity(
  config: LocalConversationRuntimeConfig,
  providerId: string,
): EvaluatorRouteIdentity {
  const kind = resolveModelCallRoute(config, providerId);
  return kind === 'custom_provider' || kind === 'configured_provider'
    ? { kind, providerId }
    : { kind };
}

function sameDataRoute(worker: EvaluatorRouteIdentity, evaluator: EvaluatorRouteIdentity): boolean {
  // Keep aligned with @mavis/goal's model-port route check; this v2 seam compares two identities
  // before a model port exists, so merging the helpers would weaken their distinct input contracts.
  if (worker.kind !== evaluator.kind) return false;
  return worker.kind !== 'custom_provider' && worker.kind !== 'configured_provider'
    ? true
    : Boolean(worker.providerId) && worker.providerId === evaluator.providerId;
}

function getSessionAgentSnapshot(
  agents: ProductionAgentProductCapabilities['agents'],
  session: SessionRecord,
): Promise<AgentExecutionSnapshot | undefined> {
  return agents.getExecutionSnapshot(session.agentName, {
    sessionId: session.sessionId,
    ...(session.appMode ? { appMode: session.appMode } : {}),
    sessionKind: isTaskSession(session) ? 'task' : session.sessionKind,
  });
}

function routeUnavailable(message: string, cause?: unknown): VerificationDispatchError {
  return new VerificationDispatchError('route_unavailable', message, emptyUsage(), {
    cause,
  });
}

function emptyUsage(): VerificationUsage {
  return { tokens: 0, activeSeconds: 0, incomplete: false };
}

function abortReason(signal: AbortSignal, fallback: unknown): Error {
  if (signal.reason instanceof Error) return signal.reason;
  if (fallback instanceof Error) return fallback;
  return new Error('Evaluator model request was aborted.');
}

function isExplicitInputTooLargeError(error: unknown): boolean {
  if (typeof error === 'string') {
    return /context window|context length|input too large|request too large|prompt is too long/iu.test(
      error,
    );
  }
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (
    typeof code === 'string' &&
    /(?:context|input|request).*(?:large|length|window)/iu.test(code)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : '';
  return /context window|context length|input too large|request too large|prompt is too long/iu.test(
    message,
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}
