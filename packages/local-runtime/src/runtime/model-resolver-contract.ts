import type { LLMModelConfig } from '@mavis/agent-core/pi-turn-runner';
import type { IAgentConfig } from '@mavis/protocol';

export interface LocalRuntimeAuthContext {
  accessToken?: string;
  loginEpoch?: string;
  realUserID?: string;
  userEmail?: string;
  userName?: string;
  subUserName?: string;
}

export interface LocalModelResolveInput {
  sessionId: string;
  turnId: string;
  agentConfig: IAgentConfig;
}

export interface LocalResolvedModelConfig extends LLMModelConfig {
  /** True only for the platform-owned Token Plan / Credits inference path. */
  managedProvider: boolean;
}

export interface LocalModelResolverLike {
  resolveModel(input: LocalModelResolveInput): Promise<LocalResolvedModelConfig>;
}
