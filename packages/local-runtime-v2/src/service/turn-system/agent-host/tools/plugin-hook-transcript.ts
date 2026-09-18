import type {
  PiHistoryChangedHookInput,
  RunTurnInput,
} from '@mavis/agent-core/pi-turn-runner';
import { PluginHookTranscript } from '@mavis/agent-tools';

export interface AgentHostPluginHookTranscript {
  readonly path: string;
  readonly codexPath: string;
  apply(change: PiHistoryChangedHookInput): Promise<void>;
  cleanup(): Promise<void>;
}

/** Concrete bridge from AgentHost transcript needs to the Desktop tool package. */
export function createAgentHostPluginHookTranscript(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly messages: NonNullable<RunTurnInput['history']>;
}): Promise<AgentHostPluginHookTranscript> {
  return PluginHookTranscript.create(input);
}
