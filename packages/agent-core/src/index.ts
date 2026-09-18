/**
 * `@mavis/agent-core`
 * -------------------
 *
 * Pure TypeScript core for Mavis agent-loop contracts.
 *
 * **Zero IO.** This package contains no filesystem access, no process
 * spawning, no SQLite, no HTTP server. IO modules belong in the host
 * packages (local-runtime, cloud-runtime).
 *
 * Subpath modules (`./event-bridge`, `./pi-turn-runner`, …) carry the
 * agent-loop assembly and conversion layers — import them directly so
 * consumers that only need protocol types pay no `@earendil-works/*`
 * loading cost.
 *
 * @see packages/agent-core/ARCHITECTURE.md
 */

export * from './protocol/index.js';
export * from './prompt-read.js';
export { collectFetchedWebSources } from '@mavis/shared/fetched-web-sources';
export { shellSourceStages } from '@mavis/shared/shell-source-stages';
export { collapseAdjacentDuplicateFileCitations } from '@mavis/shared/file-source-citation';
export {
  collectWebSourceCitations,
  collectUsedWebEvidenceIds,
  type ContextualWebCitation,
} from '@mavis/shared';
export {
  buildToolCallCitationId,
  compactToolCallCitationKey,
  findUniqueSingleSubstitutionCitationAlias,
  resolveKnownCitationAlias,
} from '@mavis/shared/source-citation-id';
