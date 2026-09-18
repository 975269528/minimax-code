/** Internal Agent composition gate. The package `./agent` export points at public.ts. */
export * from './public.js';
export {
  createRuntimeAgentComposition,
  type AgentCutoverLogEvent,
  type AgentStorageLockScope,
  type AgentRuntimeOwner,
} from './composition.js';
export { LocalPromptSnapshotSource } from './prompt-snapshot-source.js';
export { redactedAgentRef, redactedErrorFacts } from './diagnostics.js';
export { readPromptWithBuiltinFallback } from './prompt-template.js';
export type { LegacyIdentityDetachEvent } from './application/_migration-legacy-identity-detach.js';
export type { LegacyCustomAgentMaterializationEvent } from './application/legacy-custom-materialization.js';
export {
  AgentImportService,
  type AgentImportFormat,
  type AgentImportPreview,
} from './application/agent-import.js';
