import type { SessionRecord } from '../../../session-system/index.js';

import { captureSemanticSnapshot } from '../history/semantic-identity.js';

export class AgentHostSessionReadError extends Error {
  override readonly name = 'AgentHostSessionReadError';

  constructor(
    readonly sessionId: string,
    readonly reason: 'not-found' | 'identity' | 'agent-name' | 'workspace-dir' | 'session-type',
  ) {
    super(`AgentHost Session read failed for "${sessionId}": ${reason}.`);
  }
}

export function captureAgentHostSession(
  expectedSessionId: string,
  session: SessionRecord | undefined,
): SessionRecord {
  if (!session) throw new AgentHostSessionReadError(expectedSessionId, 'not-found');
  const snapshot = captureSemanticSnapshot(session).value;
  if (snapshot.sessionId !== expectedSessionId) {
    throw new AgentHostSessionReadError(expectedSessionId, 'identity');
  }
  if (!isNonEmptyString(snapshot.agentName)) {
    throw new AgentHostSessionReadError(expectedSessionId, 'agent-name');
  }
  if (!isNonEmptyString(snapshot.workspaceDir)) {
    throw new AgentHostSessionReadError(expectedSessionId, 'workspace-dir');
  }
  if (snapshot.sessionType !== 'root' && snapshot.sessionType !== 'branch') {
    throw new AgentHostSessionReadError(expectedSessionId, 'session-type');
  }
  return snapshot;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}
