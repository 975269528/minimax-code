export * from './contracts.js';
export * from './errors.js';
export { describeAgentPromptSnapshot } from './domain/prompt-snapshot.js';
export { LocalAgentService, type LocalAgentServiceOptions } from './application/agent.service.js';
export { AgentFavorites } from './application/favorites.js';
export type {
  PrimaryExecutionIdentity,
  PrimaryExecutionOutcome,
} from './domain/primary-identity.js';
export {
  BuiltinAgentCatalog,
  canonicalBuiltinName,
  legacyNamesFor,
  resolveCanonicalCapabilities,
  type BuiltinCatalogOptions,
  type BuiltinRenderInput,
  type BuiltinRenderOutput,
} from './builtin/catalog.js';
