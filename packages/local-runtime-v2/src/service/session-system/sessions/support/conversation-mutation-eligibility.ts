import { isPrimarySessionAgentName } from '../agent-name.js';
import type { SessionRecord } from '../repo/contract.js';

/** Shared business gate for the top-level primary Sessions that own conversation mutations. */
export function isConversationMutationEligibleSession(
  session: SessionRecord,
  minimumDataVersion: number,
): boolean {
  return (
    session.runtime === 'pi-agent' &&
    session.sessionOrigin === 'local-runtime' &&
    (session.sessionDataVersion ?? 0) >= minimumDataVersion &&
    isPrimarySessionAgentName(session.agentName) &&
    session.parentSessionId == null &&
    (session.sessionKind === 'conversation' || session.sessionKind === 'cron')
  );
}
