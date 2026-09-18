/**
 * `@mavis/agent-runtime` — pluggable extension SPI + assembleTurn assembler.
 *
 * See design doc: Feishu wiki "agent-runtime: A pluggable extension layer above agent-core" v1.0
 * (`.harness/docs/adr/agent-runtime-extension-layer.md` when ADR lands).
 *
 * Public surface:
 * - `createAgentRuntime(opts)`: Host entry point.
 * - `AgentRuntime` interface.
 * - `AgentExtension / ExtensionAPI / TurnAssemblyCtx / AssemblyResult` SPI types.
 * - `resolveExtensions()`: Directly callable in unit tests; hosts generally do not need it.
 *
 * The internal `Registry` implementation is a named export for tests; application code uses
 * `createAgentRuntime`.
 */

export { createAgentRuntime } from './api.js';
export {
  createExtension,
  createHookExtension,
  createPromptExtension,
  createReminderExtension,
  createToolExtension,
} from './factories.js';
export type {
  CreateExtensionOptions,
  CreateHookExtensionOptions,
  CreatePromptExtensionOptions,
  CreateReminderExtensionOptions,
  CreateToolExtensionOptions,
} from './factories.js';
export { Registry } from './registry.js';
export { resolveExtensions } from './resolve.js';
export type {
  PromptReadScope,
  PromptReadSnapshot,
  PromptSnapshotSource,
  PromptTemplateRead,
} from './prompt-read.js';
export { isPromptSnapshotInvalidError, PromptSnapshotInvalidError } from './prompt-read.js';
export { BoundedInternalTurnPromptReadRegistry } from './internal-turn-prompt-read.js';
export type { InternalTurnPromptReadRegistry } from './internal-turn-prompt-read.js';
export { defineRuntimeTool } from '@mavis/agent-core/tools';
export type { ToolExecutionContext } from '@mavis/agent-core/tools';
export {
  buildToolCallCitationId,
  collapseAdjacentDuplicateFileCitations,
  collectFetchedWebSources,
  collectWebSourceCitations,
  collectUsedWebEvidenceIds,
  shellSourceStages,
  type ContextualWebCitation,
  compactToolCallCitationKey,
  findUniqueSingleSubstitutionCitationAlias,
  resolveKnownCitationAlias,
} from '@mavis/agent-core';
export * from './types.js';
