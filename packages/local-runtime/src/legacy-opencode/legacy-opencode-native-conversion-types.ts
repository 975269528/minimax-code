/**
 * Type-only re-exports for the opencode-native → pi-agent converter.
 * Extracted so part / conversion helpers can share `NativePiHistoryLosses`
 * / `NativePiHistoryCounts` / `PiHistoryGroup` without pulling in the
 * converter's full runtime dependency graph.
 */
import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';

export interface NativePiHistoryLosses {
  emptyMessages: number;
  unknownRoles: number;
  unsupportedParts: number;
  interruptedTools: number;
  parseLoss: number;
}

/**
 * Per-role and per-block-type counts captured from the native source rows
 * (`source`) and the converted pi-agent messages (`converted`). Persisted
 * on the migration record so we can spot future silent regressions where
 * the converter drops semantic categories entirely (e.g. `source.toolCall
 * = 2323 → converted.toolCall = 0` from the incident on
 * `mvs_5e9f144c61d74d5d9a0cb748461e42a7`, tracked in the 20260712
 * post-mortem).
 *
 * `source.toolCall` counts opencode `part.data.type === 'tool'` parts —
 * each of which produces one pi-agent `toolCall` block + one `toolResult`
 * message when the state is completed / errored, so `converted.toolCall`
 * MUST equal `source.toolCall` for a healthy migration (interrupted /
 * still-running tools still emit both records with a placeholder body,
 * see `nativeToolResultMessage`).
 */
export interface NativePiHistoryCounts {
  source: {
    userMessages: number;
    assistantMessages: number;
    toolCall: number;
    reasoning: number;
    text: number;
  };
  converted: {
    userMessages: number;
    assistantMessages: number;
    toolResultMessages: number;
    toolCall: number;
    thinking: number;
    text: number;
  };
}

/**
 * A group of pi-agent messages that MUST stay adjacent and in this exact
 * order when the migration merges legacy imports with subsequent
 * pi-agent-side rows. See `legacy-opencode-native-conversion.ts` module
 * doc for the full story (v3 group-aware output).
 */
export interface PiHistoryGroup {
  leaderTimestamp: number;
  messages: PiAgentMessage[];
  kind: 'user' | 'assistant' | 'tool' | 'unknown';
  sourceMessageId?: string;
}
