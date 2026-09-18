import type { AgentHostSteeringMessage } from '../../agent-host/contracts.js';

/** Why a Turn hands its unconsumed steering over (Decision v5 discriminator). */
export type SteeringDiscardCause = 'abort' | 'abnormal-seal' | 'exit-close';

export interface TurnControllerOptions {
  readonly renew: (input: {
    readonly sessionId: string;
    readonly leaseId: string;
  }) => Promise<boolean>;
  /**
   * Receives admitted-but-unconsumed steering when a Turn stops running it.
   * Fired on abort, abnormal seal, and exit-boundary close; never after
   * consumption.
   */
  readonly onSteeringDiscarded?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly messages: readonly AgentHostSteeringMessage[];
    /**
     * Teardown discriminator (Decision v5): `exit-close` keeps the requeue
     * lane; `abort` and `abnormal-seal` fall into the conversation.
     */
    readonly cause: SteeringDiscardCause;
    /** Raw abort reason when the discard came from an abort; others carry none. */
    readonly abortReason?: string;
    /** Resolves when the Turn's in-process Session ownership is released. */
    readonly turnReleased: Promise<void>;
  }) => void;
  readonly logger?: {
    info(fields: Record<string, unknown>, message: string): void;
  };
  /** Transfers pending Queue cancellation to the registered in-process owner. */
  readonly onRegister?: (sessionId: string, turnId: string) => string | undefined;
  readonly abortTimeoutMs?: number;
  readonly renewalIntervalMs?: number;
}
