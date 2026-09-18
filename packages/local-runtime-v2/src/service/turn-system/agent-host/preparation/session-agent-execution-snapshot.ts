import type { SessionRecord } from '../../../session-system/index.js';

import type { AgentExecutionSnapshot, AgentExecutionSource } from './contracts.js';

/** Keeps every Session-aware Agent snapshot read on the same immutable Task policy. */
export function readSessionAgentExecutionSnapshot<TAgent extends AgentExecutionSnapshot>(
  agents: AgentExecutionSource<TAgent>,
  session: SessionRecord,
): Promise<TAgent | undefined> {
  return agents.getExecutionSnapshot(session.agentName, {
    sessionId: session.sessionId,
    ...(session.appMode ? { appMode: session.appMode } : {}),
    sessionKind: session.sessionKind,
  });
}
