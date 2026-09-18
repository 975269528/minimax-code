/**
 * Product-internal tool lifecycle types.
 *
 * Hooks follow the (input, output) => Promise<void> pattern where
 * handlers mutate `output` in-place to modify the operation's result.
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * Internal handler follows the (input, output) => Promise<void> pattern.
 * Handlers mutate `output` in-place to modify the operation's result.
 */
export type HookHandler<TInput, TOutput> = (
  input: Readonly<TInput>,
  output: TOutput,
) => Promise<void>;

/**
 * Hook registration metadata.
 */
export interface HookRegistration<TInput = unknown, TOutput = unknown> {
  /** Unique identifier; registering again replaces the internal handler. */
  id: string;
  /** Product-owned tool lifecycle event. */
  hookEvent: 'PreToolUse' | 'PostToolUse';
  /** Scoped to a specific agent. Omit or '*' to apply globally. */
  agentName?: string;
  /** Execution priority — lower numbers run first. */
  priority: number;
  /**
   * Regex matcher for conditional filtering.
   * Matches the tool name.
   * Use "*", "", or omit to match all occurrences.
   */
  matcher?: string;
  /** Timeout in ms for this hook's execution. */
  timeout: number;
  /** The handler function. */
  handler: HookHandler<TInput, TOutput>;
}

/**
 * Result of executing a hook chain.
 */
export interface HookChainResult<TOutput> {
  /** Final output after all hooks have run. */
  output: TOutput;
  /** Whether any hook aborted the chain (gating). */
  aborted: boolean;
  /** Abort reason, if aborted. */
  abortReason?: string;
  /** Number of hooks that executed. */
  executedCount: number;
  /** Errors from individual hooks (isolated, non-fatal). */
  errors: Array<{ hookId: string; error: Error }>;
}

/**
 * Gating interface — hooks set `_abort` on the output to gate operations.
 * Service code checks `result.aborted` after hook execution.
 */
export interface Gatable {
  _abort?: { reason: string };
}

/** PreToolUse — triggered before a tool call executes. */
export interface PreToolUseInput {
  agentName: string;
  sessionId: string;
  /** Current model turn identifier, when provided by the caller. */
  turnId?: string;
  toolName: string;
  toolSource?: string;
  toolCallId?: string;
  toolArgs: Record<string, unknown>;
  /** The model identifier for the calling agent (e.g. "provider/modelID"). */
  model?: string;
}

export interface PreToolUseOutput extends Gatable {
  toolArgs: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

/** PostToolUse — triggered after a tool call succeeds. */
export interface PostToolUseInput {
  agentName: string;
  sessionId: string;
  /** Current model turn identifier, when provided by the caller. */
  turnId?: string;
  toolName: string;
  toolSource?: string;
  toolCallId?: string;
  toolArgs: Record<string, unknown>;
  toolResult: unknown;
}

export interface PostToolUseOutput extends Gatable {
  metadata: Record<string, unknown>;
  /**
   * Optional override for the tool result seen by the agent.
   *
   * Internal tool handlers may replace the result before it reaches the Agent.
   */
  toolResult?: unknown;
}
