import type {
  AcceptedCompactionLease,
  AcceptedTurnLease,
  AgentCompactionInput,
  AgentHostCloseResult,
  AgentHostExecutionRequest,
  AgentHostScopedTurnControl,
  AgentHostSteeringMessage,
  AgentHostTurnOutcome,
  CompactionOutcome,
} from '../agent-host/contracts.js';
import type {
  AbortTurnInput,
  AbortTurnResult,
  ActivateTurnResult,
  DirectTurnSubmission,
  QueueTurnSubmission,
  RequestCompactionInput,
  RequestCompactionResult,
} from '../contracts.js';
import type { TurnBusyReason } from '../persistence/contracts.js';

export type AcceptedAgentTurn = AcceptedTurnLease & { foreground?: true };
export type AcceptedCompactionTurn = AcceptedCompactionLease;
export type AcceptedTurn = AcceptedAgentTurn | AcceptedCompactionTurn;

export interface RegisterAcceptedTurnInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly leaseId: string;
  readonly acceptedSequence: number;
  readonly acceptedAtMs: number;
  readonly busyReason: TurnBusyReason;
  readonly foreground?: true;
}

export type SteerTurnResult =
  | { readonly status: 'accepted'; readonly turnId: string }
  | {
      readonly status:
        | 'not-running'
        | 'turn-mismatch'
        | 'unsupported-delivery'
        | 'delivery-closed'
        | 'closing';
    };

/**
 * In-process accepted-Turn owner. Its shape satisfies the narrow AgentHost
 * controls at composition without inheriting AgentHost-owned interfaces.
 */
export interface TurnController {
  register(input: RegisterAcceptedTurnInput & { readonly busyReason: 'turn' }): AcceptedAgentTurn;
  register(
    input: RegisterAcceptedTurnInput & { readonly busyReason: 'compaction' },
  ): AcceptedCompactionTurn;
  scope(lease: AcceptedTurnLease): AgentHostScopedTurnControl;
  abort(input: AbortTurnInput): Promise<AbortTurnResult>;
  steerActiveTurn(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
    readonly foreground?: true;
  }): Promise<SteerTurnResult>;
  steerToolResultTail(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
  }): Promise<SteerTurnResult>;
  /**
   * True while the session's active Turn holds admitted-but-unconsumed
   * steering from a user producer. Read by the ask_user suppression probe
   * (Decision v3): a question raised while the user has an instruction in
   * flight is superseded, not asked.
   */
  hasPendingUserSteering(sessionId: string): boolean;
  beginClose(lease: AcceptedCompactionLease): AgentHostCloseResult;
  complete(turn: AcceptedTurn): void;
  activeTurnId(sessionId: string): string | undefined;
  close(): Promise<void>;
}

export interface TurnSessionCapabilities {
  has(sessionId: string): Promise<boolean>;
}

export type TurnExecutionSubmission = DirectTurnSubmission | QueueTurnSubmission;

export interface TurnExecutionService {
  submit(input: TurnExecutionSubmission): Promise<ActivateTurnResult>;
  /** Requires the caller to hold the matching Session exclusive mutation lease. */
  submitTrusted(input: TurnExecutionSubmission): Promise<ActivateTurnResult>;
  requestCompaction(input: RequestCompactionInput): Promise<RequestCompactionResult>;
  steerActiveTurn(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly message: AgentHostSteeringMessage;
    readonly foreground?: true;
  }): Promise<SteerTurnResult>;
  abort(input: AbortTurnInput): Promise<AbortTurnResult>;
  activeTurnId(sessionId: string): string | undefined;
}

export interface ExecutionCoordinator {
  startTurn(input: {
    readonly turn: AcceptedAgentTurn;
    readonly request: AgentHostExecutionRequest;
    readonly executionStart?: Promise<void>;
  }): Promise<{ readonly completion: Promise<AgentHostTurnOutcome> }>;
  failTurn(input: {
    readonly turn: AcceptedAgentTurn;
    readonly error: unknown;
  }): Promise<{ readonly completion: Promise<AgentHostTurnOutcome> }>;
  failAdmission(input: {
    readonly admission: RegisterAcceptedTurnInput;
    readonly error: unknown;
  }): Promise<{
    readonly completion: Promise<Extract<AgentHostTurnOutcome, { readonly status: 'failed' }>>;
  }>;
  compact(input: AgentCompactionInput): Promise<CompactionOutcome>;
}
