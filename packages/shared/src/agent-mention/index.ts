export {
  AGENT_REFERENCE_ERROR_CODES,
  escapeAgentReferenceLiterals,
  parseAgentReferences,
  serializeAgentReference,
} from './protocol.js';
export type {
  AgentReference,
  AgentReferenceErrorCode,
  AgentReferenceMentionSegment,
  AgentReferenceSegment,
  AgentReferenceTextSegment,
  ParseAgentReferencesResult,
} from './protocol.js';

export { projectAgentReferenceForModel, projectAgentReferencesForModel } from './projection.js';
export type {
  AgentMentionSurface,
  AuthorizedAgentReferenceResolution,
  AgentReferenceResolution,
  ProjectAgentReferencesForModelOptions,
  ProjectAgentReferencesForModelResult,
} from './projection.js';
