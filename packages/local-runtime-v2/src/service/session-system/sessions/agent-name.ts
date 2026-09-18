import type { SessionRecord } from './repo/contract.js';

export const PRIMARY_SESSION_AGENT_NAMES = ['mavis', 'main'] as const;

export function isPrimarySessionAgentName(agentName: string): boolean {
  return agentName === 'mavis' || agentName === 'main';
}

export function isSameSessionAgentName(left: string, right: string): boolean {
  return left === right || (isPrimarySessionAgentName(left) && isPrimarySessionAgentName(right));
}

export function projectPrimarySessionAgentName(
  record: SessionRecord,
  requestedAgentName: string,
): SessionRecord {
  if (
    !isPrimarySessionAgentName(requestedAgentName) ||
    !isPrimarySessionAgentName(record.agentName) ||
    record.agentName === requestedAgentName
  ) {
    return record;
  }
  return { ...record, agentName: requestedAgentName };
}
