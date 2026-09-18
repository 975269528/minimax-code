import { AgentConfigError } from '../storage/canonical-agent-config.js';
import { isHarnessAgent } from '../domain/names.js';
import type {
  AgentStoreMeta,
  AgentStorePort,
  LegacyCustomAgentMaterializationEvent,
  LegacyCustomAgentMaterializationResult,
} from '../contracts.js';

export type { LegacyCustomAgentMaterializationEvent } from '../contracts.js';

export type LegacyCustomAgentMaterializationReporter = (
  event: LegacyCustomAgentMaterializationEvent,
) => void;

export interface LegacyCustomAgentMaterializationSummary {
  readonly materialized: number;
  readonly alreadyCanonical: number;
  readonly notLegacy: number;
  readonly invalid: number;
}

export async function materializeLegacyCustomAgentRows(input: {
  readonly repository: AgentStorePort;
  readonly report: LegacyCustomAgentMaterializationReporter | undefined;
  readonly isBuiltin: (meta: AgentStoreMeta) => boolean;
}): Promise<LegacyCustomAgentMaterializationSummary> {
  if (!input.repository.materializeLegacyCustomAgent) {
    return { materialized: 0, alreadyCanonical: 0, notLegacy: 0, invalid: 0 };
  }
  const metas = (
    input.repository.listLegacyCustomAgents
      ? await input.repository.listLegacyCustomAgents()
      : await input.repository.list()
  ).filter((meta) => !input.isBuiltin(meta) && !isHarnessAgent(meta));
  const result = { materialized: 0, alreadyCanonical: 0, notLegacy: 0, invalid: 0 };
  let canonicalIdentityReconciled = 0;
  let failed = 0;
  for (const meta of metas) {
    const attempt = await materializeLegacyCustomAgentAttempt(
      input.repository,
      input.report,
      meta.name,
    );
    if (typeof attempt === 'string') {
      result.invalid += Number(attempt === 'invalid');
      failed += Number(attempt === 'failed');
      continue;
    }
    switch (attempt.outcome) {
      case 'materialized':
        result.materialized += 1;
        break;
      case 'canonical_identity_reconciled':
        canonicalIdentityReconciled += 1;
        break;
      case 'already_canonical':
        result.alreadyCanonical += 1;
        break;
      case 'not_legacy':
        result.notLegacy += 1;
        break;
    }
  }
  await input.repository.reconcileCanonicalCustomAgents?.();
  const receipt = await completeLegacyCustomIdentityReconciliation(
    input.repository,
    result.invalid,
    failed,
  );
  emitLegacyCustomMaterialization(input.report, {
    kind: 'summary',
    materialized: result.materialized,
    canonicalIdentityReconciled,
    alreadyCanonical: result.alreadyCanonical,
    notLegacy: result.notLegacy,
    invalid: result.invalid,
    failed: failed + receipt.failed,
    receiptCompleted: receipt.completed,
  });
  return result;
}

type LegacyCustomAgentMaterializationAttempt =
  | LegacyCustomAgentMaterializationResult
  | 'invalid'
  | 'failed';

async function materializeLegacyCustomAgentAttempt(
  repository: AgentStorePort,
  report: LegacyCustomAgentMaterializationReporter | undefined,
  name: string,
): Promise<LegacyCustomAgentMaterializationAttempt> {
  try {
    if (!repository.materializeLegacyCustomAgent) {
      return legacyMaterializationFallback('not-legacy');
    }
    const materialization = repository.materializeLegacyCustomAgentForStartup
      ? await repository.materializeLegacyCustomAgentForStartup(name)
      : legacyMaterializationFallback(await repository.materializeLegacyCustomAgent(name));
    emitLegacyCustomMaterialization(report, { kind: 'agent', agentName: name, ...materialization });
    return materialization;
  } catch (error) {
    if (!isPerAgentConfigFailure(error)) throw error;
    return reportLegacyCustomMaterialization(report, name, error);
  }
}

async function completeLegacyCustomIdentityReconciliation(
  repository: AgentStorePort,
  invalid: number,
  failed: number,
): Promise<{ readonly completed: boolean; readonly failed: number }> {
  if (invalid > 0 || failed > 0 || !repository.completeLegacyCustomIdentityReconciliation) {
    return { completed: false, failed: 0 };
  }
  await repository.completeLegacyCustomIdentityReconciliation();
  return { completed: true, failed: 0 };
}

function emitLegacyCustomMaterialization(
  report: ((event: LegacyCustomAgentMaterializationEvent) => void) | undefined,
  event: LegacyCustomAgentMaterializationEvent,
): void {
  try {
    report?.(event);
  } catch {
    // Observability must never change startup recovery.
  }
}

function reportLegacyCustomMaterialization(
  report: LegacyCustomAgentMaterializationReporter | undefined,
  agentName: string,
  error: unknown,
): 'invalid' | 'failed' {
  const unreadable = isPerAgentReadAccessError(error);
  const outcome = isExistingInvalidCanonicalConfig(error) || unreadable ? 'invalid' : 'failed';
  emitLegacyCustomMaterialization(report, {
    kind: 'agent',
    agentName,
    outcome,
    errorCode: materializationErrorCode(error, unreadable),
    identitySource: 'none',
    recoveredFields: [],
    stage: 'materialization',
    reason: unreadable ? 'unreadable' : materializationFailureReason(error),
  });
  return outcome;
}

function materializationErrorCode(
  error: unknown,
  unreadable: boolean,
): AgentConfigError['code'] | 'unknown' {
  if (error instanceof AgentConfigError) return error.code;
  if (unreadable) return 'AGENT_CONFIG_INVALID';
  return 'unknown';
}

function legacyMaterializationFallback(
  outcome: 'already-canonical' | 'materialized' | 'not-legacy',
): LegacyCustomAgentMaterializationResult {
  switch (outcome) {
    case 'materialized':
      return { outcome: 'materialized', identitySource: 'none', recoveredFields: [] };
    case 'already-canonical':
      return { outcome: 'already_canonical', identitySource: 'none', recoveredFields: [] };
    case 'not-legacy':
      return { outcome: 'not_legacy', identitySource: 'none', recoveredFields: [] };
  }
}

function isExistingInvalidCanonicalConfig(error: unknown): boolean {
  return (
    error instanceof AgentConfigError &&
    (error.code === 'AGENT_CONFIG_NOT_FOUND' ||
      error.code === 'AGENT_CONFIG_INVALID' ||
      error.code === 'AGENT_CONFIG_AVATAR_INVALID' ||
      error.code === 'AGENT_CONFIG_UNSTABLE')
  );
}

function isPerAgentConfigFailure(error: unknown): boolean {
  return isExistingInvalidCanonicalConfig(error) || isPerAgentReadAccessError(error);
}

function isPerAgentReadAccessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function materializationFailureReason(error: unknown): 'missing' | 'invalid' | 'unreadable' {
  if (!(error instanceof AgentConfigError)) return 'invalid';
  return error.code === 'AGENT_CONFIG_NOT_FOUND' ? 'missing' : 'invalid';
}
