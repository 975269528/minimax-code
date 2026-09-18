import type { AgentMessage as PiAgentMessage } from '@earendil-works/pi-agent-core';
import { Role, type AgentMessage } from '@mavis/agent-core/protocol/agent-message';

export function isTerminalAssistantDisplayError(message: AgentMessage): boolean {
  return message.role === Role.Assistant && readFinishReason(message) === 'error';
}

export function isTerminalAssistantPiError(message: PiAgentMessage): boolean {
  const record = message as { role?: unknown; stopReason?: unknown };
  return record.role === 'assistant' && record.stopReason === 'error';
}

function readStringField(value: object, key: string): string | undefined {
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
}

function readFinishReason(message: AgentMessage): string | undefined {
  return readStringField(message, 'finish_reason') ?? readStringField(message, 'finishReason');
}
