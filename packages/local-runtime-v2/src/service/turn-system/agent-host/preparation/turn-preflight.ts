import type { TurnAssemblyCtx } from '@mavis/agent-runtime';
import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';

import type { SessionRecord } from '../../../session-system/index.js';
import { createSecretFreeTurnAssemblyContext } from '../assembly-context.js';
import { createCanonicalAgentHostUserInput } from '../canonical-user-input.js';
import type { AgentHostDependencies, AgentHostRunInput } from '../contracts.js';
import type { AgentHostTurnCapabilityView } from '../assembly/turn-capability-lifecycle.js';
import type { CanonicalHistorySnapshot } from '../history/contracts.js';
import type {
  AgentExecutionSnapshot,
  AgentHostCanonicalUserInput,
  LocalTurnPreparation,
} from './contracts.js';
import { captureAgentHostSession } from './session-read.js';
import { copyCanonicalHistoryForPiCompatibility } from '../history/canonical-history-validation.js';
import { readSessionAgentExecutionSnapshot } from './session-agent-execution-snapshot.js';
import { continuationRunnerHistory } from '../history/continuation-history.js';

export type AgentTurnSetupStage =
  | 'capability_acquisition'
  | 'session_read'
  | 'plan_document_resolution'
  | 'agent_snapshot'
  | 'history_read'
  | 'agent_preparation'
  | 'tool_catalog_build'
  | 'agent_runtime_assembly'
  | 'runtime_assembly'
  | 'assembly_observer'
  | 'turn_start_handlers';

export interface AgentTurnSetupLogContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly executionMode?: string;
}

type AgentTurnSetupLogger = Pick<PiTurnRunnerLogger, 'info' | 'error'>;

export class AgentExecutionSnapshotNotFoundError extends Error {
  override readonly name = 'AgentExecutionSnapshotNotFoundError';

  constructor(readonly agentName: string) {
    super(`Agent execution snapshot not found: ${agentName}`);
  }
}

export class AgentEventAssociationError extends Error {
  override readonly name = 'AgentEventAssociationError';

  constructor(
    readonly field: 'sessionId' | 'turnId' | 'agentName',
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Agent event ${field} mismatch: expected "${expected}", received "${actual}".`);
  }
}

export interface TurnPreflightResult<TAgent extends AgentExecutionSnapshot> {
  readonly session: SessionRecord;
  readonly agent: TAgent;
  readonly preparation: LocalTurnPreparation;
  readonly history: CanonicalHistorySnapshot;
  /** Provider-facing history; continuation may omit one interrupted assistant attempt. */
  readonly runnerHistory: CanonicalHistorySnapshot;
  readonly assemblyContext: TurnAssemblyCtx;
  readonly canonicalUserInput: AgentHostCanonicalUserInput;
}

type TurnPreflightDependencies<TAgent extends AgentExecutionSnapshot> = Pick<
  AgentHostDependencies<TAgent>,
  | 'sessions'
  | 'planDocuments'
  | 'agents'
  | 'turnRuntimeFacts'
  | 'history'
  | 'preparation'
  | 'internalTurnPromptReads'
  | 'logger'
>;

/**
 * Captures one immutable, secret-free execution scope before AgentRuntime
 * assembly. The Host remains the owner of assembly and the lifecycle sequence.
 */
export class TurnPreflight<TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot> {
  constructor(private readonly dependencies: TurnPreflightDependencies<TAgent>) {}

  async prepare(
    input: AgentHostRunInput,
    desktopCapabilities?: AgentHostTurnCapabilityView,
  ): Promise<TurnPreflightResult<TAgent>> {
    const logContext = {
      sessionId: input.lease.sessionId,
      turnId: input.lease.turnId,
      executionMode: input.request.executionMode ?? 'activate',
    };
    const session = captureAgentHostSession(
      input.lease.sessionId,
      await observeAgentTurnSetupStage(this.dependencies.logger, logContext, 'session_read', () =>
        this.dependencies.sessions.get(input.lease.sessionId),
      ),
    );
    const plan =
      session.interactionMode === 'plan'
        ? {
            active: true as const,
            canonicalPath: (
              await observeAgentTurnSetupStage(
                this.dependencies.logger,
                logContext,
                'plan_document_resolution',
                () => requirePlanDocuments(this.dependencies).resolveAndEnsure(session.sessionId),
              )
            ).canonicalPath,
          }
        : undefined;
    // Storage owner and execution owner are captured exactly once. A concurrent
    // Agent roster refresh must not move an in-flight Turn back onto the legacy
    // owner, so nothing below re-resolves either name.
    const storageOwnerName = session.agentName;
    const snapshot = await observeAgentTurnSetupStage(
      this.dependencies.logger,
      logContext,
      'agent_snapshot',
      () => readSessionAgentExecutionSnapshot(this.dependencies.agents, session),
    );
    if (!snapshot) throw new AgentExecutionSnapshotNotFoundError(storageOwnerName);
    // Association keeps validating the storage owner so the ledger owner stays
    // unambiguous; the execution owner is a separate, behaviour-only field.
    validateAgentAssociation(storageOwnerName, snapshot);
    const agent = freezeTurnExecutionSnapshot(
      freezeExecutionOwner(snapshot),
      this.dependencies.turnRuntimeFacts?.snapshot(),
    );
    const history = await observeAgentTurnSetupStage(
      this.dependencies.logger,
      logContext,
      'history_read',
      () => this.dependencies.history.read(input.lease.sessionId),
    );
    const runnerHistory =
      input.request.executionMode === 'continuation' ? continuationRunnerHistory(history) : history;
    const canonicalUserInput = createCanonicalAgentHostUserInput(input.request);
    const internalPromptRead = this.dependencies.internalTurnPromptReads?.take(input.lease.turnId);
    const preparation = await observeAgentTurnSetupStage(
      this.dependencies.logger,
      logContext,
      'agent_preparation',
      () =>
        this.dependencies.preparation.prepare({
          turnId: input.lease.turnId,
          request: input.request,
          session,
          agent,
          history: runnerHistory,
          ...(desktopCapabilities ? { desktopCapabilities } : {}),
          ...(internalPromptRead ? { promptRead: internalPromptRead } : {}),
        }),
    );
    const effectiveUserInput = replaceRetryContinuationPrompt(canonicalUserInput, preparation);
    const assemblyContext = createSecretFreeTurnAssemblyContext({
      input,
      session,
      agent,
      preparation,
      history: copyCanonicalHistoryForPiCompatibility(runnerHistory.messages),
      canonicalUserInput: effectiveUserInput,
      ...(plan ? { plan } : {}),
      ...(preparation.promptRead ? { promptRead: preparation.promptRead } : {}),
    });
    return {
      session,
      agent,
      preparation,
      history,
      runnerHistory,
      assemblyContext,
      canonicalUserInput: effectiveUserInput,
    };
  }
}

function replaceRetryContinuationPrompt(
  input: AgentHostCanonicalUserInput,
  preparation: LocalTurnPreparation,
): AgentHostCanonicalUserInput {
  const prompt = preparation.retryContinuationPrompt;
  if (!prompt || input.messages.length !== 1) return input;
  const first = input.messages[0];
  if (!first) return input;
  return Object.freeze({
    text: prompt,
    messages: Object.freeze([Object.freeze({ ...first, text: prompt })]),
  });
}

/** Best-effort timing around one pre-LLM setup stage. */
export async function observeAgentTurnSetupStage<T>(
  logger: AgentTurnSetupLogger | undefined,
  context: AgentTurnSetupLogContext,
  stage: AgentTurnSetupStage,
  operation: () => T | Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  logSetupEvent(
    logger,
    'info',
    setupFields(context, stage, 'started'),
    '[local-runtime-v2] agent turn setup stage started',
  );
  try {
    const result = await operation();
    logSetupEvent(
      logger,
      'info',
      {
        ...setupFields(context, stage, 'completed'),
        duration_ms: Math.max(0, Date.now() - startedAtMs),
      },
      '[local-runtime-v2] agent turn setup stage completed',
    );
    return result;
  } catch (error) {
    logSetupEvent(
      logger,
      'error',
      {
        ...setupFields(context, stage, 'failed'),
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        error_type: error instanceof Error ? error.name : typeof error,
      },
      '[local-runtime-v2] agent turn setup stage failed',
    );
    throw error;
  }
}

function setupFields(
  context: AgentTurnSetupLogContext,
  stage: AgentTurnSetupStage,
  status: 'started' | 'completed' | 'failed',
): Record<string, unknown> {
  return {
    event: `agent_turn_setup_stage_${status}`,
    session_id: context.sessionId,
    turn_id: context.turnId,
    execution_mode: context.executionMode ?? 'activate',
    setup_stage: stage,
  };
}

function logSetupEvent(
  logger: AgentTurnSetupLogger | undefined,
  level: 'info' | 'error',
  fields: Record<string, unknown>,
  message: string,
): void {
  try {
    if (level === 'info') logger?.info?.(fields, message);
    else logger?.error?.(fields, message);
  } catch {
    // Diagnostics must never change Turn preparation behavior.
  }
}

function requirePlanDocuments<TAgent extends AgentExecutionSnapshot>(
  dependencies: TurnPreflightDependencies<TAgent>,
): NonNullable<TurnPreflightDependencies<TAgent>['planDocuments']> {
  if (!dependencies.planDocuments) {
    throw new Error('Plan document resolver is unavailable for an accepted Plan Turn');
  }
  return dependencies.planDocuments;
}

function validateAgentAssociation(expectedAgentName: string, agent: AgentExecutionSnapshot): void {
  if (agent.agentName !== expectedAgentName) {
    throw new AgentEventAssociationError('agentName', expectedAgentName, agent.agentName);
  }
}

/** Materializes the behaviour owner so every later stage reads one frozen value. */
function freezeExecutionOwner<TAgent extends AgentExecutionSnapshot>(agent: TAgent): TAgent {
  return agent.executionOwnerName ? agent : { ...agent, executionOwnerName: agent.agentName };
}

function freezeTurnExecutionSnapshot<TAgent extends AgentExecutionSnapshot>(
  agent: TAgent,
  runtimeFacts: { readonly cuModeActive: boolean } | undefined,
): TAgent {
  return runtimeFacts ? { ...agent, cuModeActive: runtimeFacts.cuModeActive } : agent;
}
