import { and, eq } from 'drizzle-orm';

import type { AppDb } from '../../infra/db/client.js';
import { sessionAgentDefinitions, sessions } from '../../infra/db/schema/sessions.js';
import { isPrimarySessionAgentName } from './sessions/agent-name.js';
import {
  decodeSessionAgentDefinition,
  isCurrentSessionAgentDefinition,
  serializeSessionAgentDefinition,
} from './sessions/repo/agent-binding.js';
import {
  CURRENT_SESSION_COLUMNAR_VERSION,
  decodeSessionRow,
  encodeSessionRow,
} from './sessions/repo/drizzle/codec.js';
import type { SessionRecord } from './sessions/repo/contract.js';
import type { RootAgentPort, RootAgentRecord } from './sessions/root/root-invariant-service.js';
import { normalizeAbsolutePath, pathFlavor } from './shared/path-normalization.js';
import {
  canonicalProjectWorkspaceDir,
  isAgentInternalDefaultWorkspaceDir,
  isSessionDefaultWorkspaceDir,
} from './shared/workspace.js';

export interface RootProjectHistoryRepairSummary {
  readonly scanned: number;
  readonly repaired: number;
  readonly repairedSessionIds: readonly string[];
  readonly failed: number;
  readonly skipped: Readonly<Record<string, number>>;
}

interface RootProjectHistoryRepairFailure {
  readonly stage: 'scan' | 'candidate';
  readonly error: string;
  readonly sessionId?: string;
  readonly agentName?: string;
}

/** Optional production logging; repair remains non-blocking when it fails. */
export interface RootProjectHistoryRepairDiagnostics {
  reportSummary(summary: RootProjectHistoryRepairSummary): void;
  reportFailure(entry: RootProjectHistoryRepairFailure): void;
}

export interface RootProjectHistoryRepairInput {
  readonly db: AppDb;
  readonly dataDir: string;
  readonly defaultWorkspaceDir: () => string;
  readonly rootAgents: RootAgentPort;
  readonly diagnostics?: RootProjectHistoryRepairDiagnostics;
}

/**
 * Correct one narrowly proven legacy error: an Agent root whose configured
 * Project directory was written with the default-Project bit. This deliberately
 * has no durable marker: later starts re-check the remaining, still-default rows.
 */
export async function repairRootProjectHistory(
  input: RootProjectHistoryRepairInput,
): Promise<RootProjectHistoryRepairSummary> {
  const summary = createSummary();
  let rows: readonly SessionStorageRow[];

  try {
    rows = selectCandidateRows(input.db);
  } catch (error) {
    summary.failed += 1;
    reportFailure(input.diagnostics, { stage: 'scan', error: describeError(error) });
    return reportSummary(input.diagnostics, summary);
  }

  const context = repairContext(input);
  for (const row of rows) {
    summary.scanned += 1;
    const outcome = await repairCandidateRow({ input, row, context });
    recordCandidateOutcome(summary, input.diagnostics, outcome);
  }
  return reportSummary(input.diagnostics, summary);
}

interface RepairContext {
  readonly dataDir: string;
  readonly defaultWorkspaceDir: string;
}

interface MutableSummary {
  scanned: number;
  repaired: number;
  repairedSessionIds: string[];
  failed: number;
  skipped: Record<string, number>;
}

type SessionStorageRow = typeof sessions.$inferSelect;
type AppDbTransaction = Parameters<Parameters<AppDb['transaction']>[0]>[0];

type CandidateRepairOutcome =
  | { readonly kind: 'repaired'; readonly sessionId: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly failure: RootProjectHistoryRepairFailure };

function createSummary(): MutableSummary {
  return { scanned: 0, repaired: 0, repairedSessionIds: [], failed: 0, skipped: {} };
}

function selectCandidateRows(db: AppDb): readonly SessionStorageRow[] {
  return db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.columnarVersion, CURRENT_SESSION_COLUMNAR_VERSION),
        eq(sessions.runtime, 'pi-agent'),
        eq(sessions.sessionType, 'root'),
        eq(sessions.sessionKind, 'conversation'),
        eq(sessions.archived, 0),
        eq(sessions.isDefaultWorkspace, 1),
      ),
    )
    .all();
}

async function repairCandidateRow(input: {
  readonly input: RootProjectHistoryRepairInput;
  readonly row: SessionStorageRow;
  readonly context: RepairContext | undefined;
}): Promise<CandidateRepairOutcome> {
  try {
    const record = decodeSessionRow(input.row);
    const staticReason = staticSkipReason(record);
    if (staticReason) return { kind: 'skipped', reason: staticReason };

    const context = input.context;
    if (!context) return { kind: 'skipped', reason: 'runtime-workspace-unavailable' };

    const agent = await input.input.rootAgents.get(record.agentName);
    if (!agent) return { kind: 'skipped', reason: 'agent-owner-mismatch' };
    const agentReason = matchingAgentReason(record, agent);
    if (agentReason) return { kind: 'skipped', reason: agentReason };

    const workspaceReason = projectWorkspaceReason({ record, agent, ...context });
    if (workspaceReason) return { kind: 'skipped', reason: workspaceReason };

    const result = input.input.db.transaction(
      (tx) => repairCandidateInTransaction({ tx, record, agent, ...context }),
      { behavior: 'immediate' },
    );
    return result === 'repaired'
      ? { kind: 'repaired', sessionId: record.sessionId }
      : { kind: 'skipped', reason: result };
  } catch (error) {
    return {
      kind: 'failed',
      failure: {
        stage: 'candidate',
        error: describeError(error),
        sessionId: input.row.sessionId,
        ...(input.row.agentName ? { agentName: input.row.agentName } : {}),
      },
    };
  }
}

function recordCandidateOutcome(
  summary: MutableSummary,
  diagnostics: RootProjectHistoryRepairDiagnostics | undefined,
  outcome: CandidateRepairOutcome,
): void {
  if (outcome.kind === 'repaired') {
    summary.repaired += 1;
    summary.repairedSessionIds.push(outcome.sessionId);
    return;
  }
  if (outcome.kind === 'skipped') {
    skip(summary, outcome.reason);
    return;
  }
  summary.failed += 1;
  reportFailure(diagnostics, outcome.failure);
}

function repairContext(input: RootProjectHistoryRepairInput): RepairContext | undefined {
  try {
    const dataDir = normalizeAbsolutePath(input.dataDir);
    const defaultWorkspaceDir = normalizeAbsolutePath(input.defaultWorkspaceDir());
    return dataDir && defaultWorkspaceDir ? { dataDir, defaultWorkspaceDir } : undefined;
  } catch {
    return undefined;
  }
}

function staticSkipReason(record: SessionRecord): string | undefined {
  if (
    record.runtime !== 'pi-agent' ||
    record.sessionType !== 'root' ||
    record.sessionKind !== 'conversation' ||
    record.archived ||
    record.parentSessionId !== null ||
    record.origin !== 'root-repair' ||
    record.isDefaultWorkspace !== true ||
    record.runLocation !== undefined
  ) {
    return 'unproven-session';
  }
  return isPrimarySessionAgentName(record.agentName) ? 'primary-agent' : undefined;
}

function matchingAgentReason(
  record: SessionRecord,
  agent: RootAgentRecord,
): string | undefined {
  if (agent.agentName !== record.agentName) return 'agent-owner-mismatch';
  if (agent.rootSessionId !== record.sessionId) return 'agent-root-mismatch';
  return normalizeAbsolutePath(agent.defaultWorkspaceDir)
    ? undefined
    : 'agent-workspace-unavailable';
}

function projectWorkspaceReason(input: {
  readonly record: SessionRecord;
  readonly agent: RootAgentRecord;
  readonly dataDir: string;
  readonly defaultWorkspaceDir: string;
}): string | undefined {
  const workspaceDir = matchingAgentProjectWorkspace(input.record, input.agent);
  if (!workspaceDir) return 'agent-workspace-mismatch';
  return (
    runtimeWorkspaceReason({
      workspaceDir,
      record: input.record,
      dataDir: input.dataDir,
      defaultWorkspaceDir: input.defaultWorkspaceDir,
    }) ??
    agentInternalWorkspaceReason({ workspaceDir, record: input.record, dataDir: input.dataDir })
  );
}

function matchingAgentProjectWorkspace(
  record: SessionRecord,
  agent: RootAgentRecord,
): string | undefined {
  const workspaceDir = normalizeAbsolutePath(record.workspaceDir);
  const agentWorkspaceDir = normalizeAbsolutePath(agent.defaultWorkspaceDir);
  if (!workspaceDir || !agentWorkspaceDir) return undefined;
  return samePath(workspaceDir, agentWorkspaceDir) ? workspaceDir : undefined;
}

function runtimeWorkspaceReason(input: {
  readonly workspaceDir: string;
  readonly record: SessionRecord;
  readonly dataDir: string;
  readonly defaultWorkspaceDir: string;
}): string | undefined {
  if (!hasMatchingPathFlavor(input.workspaceDir, input.dataDir, input.defaultWorkspaceDir)) {
    return 'workspace-flavor-mismatch';
  }
  if (!canonicalProjectWorkspaceDir(input.workspaceDir)) return 'workspace-not-project';
  if (samePath(input.workspaceDir, input.defaultWorkspaceDir)) return 'runtime-default-workspace';
  if (isWithinDirectory(input.workspaceDir, input.dataDir)) return 'runtime-data-workspace';
  return isSessionDefaultWorkspaceDir(input.workspaceDir, input.record.sessionId)
    ? 'session-default-workspace'
    : undefined;
}

function hasMatchingPathFlavor(
  workspaceDir: string,
  dataDir: string,
  defaultWorkspaceDir: string,
): boolean {
  return (
    pathFlavor(workspaceDir) === pathFlavor(dataDir) &&
    pathFlavor(workspaceDir) === pathFlavor(defaultWorkspaceDir)
  );
}

function agentInternalWorkspaceReason(input: {
  readonly workspaceDir: string;
  readonly record: SessionRecord;
  readonly dataDir: string;
}): string | undefined {
  const internalWorkspaceDir = normalizeAbsolutePath(
    pathFlavor(input.dataDir).join(input.dataDir, 'agents', input.record.agentName, 'workspace'),
  );
  if (!internalWorkspaceDir) return undefined;
  return isAgentInternalDefaultWorkspaceDir(
    input.workspaceDir,
    internalWorkspaceDir,
    input.record.agentName,
  )
    ? 'agent-internal-workspace'
    : undefined;
}

interface CandidateTransactionInput {
  readonly tx: AppDbTransaction;
  readonly record: SessionRecord;
  readonly agent: RootAgentRecord;
  readonly dataDir: string;
  readonly defaultWorkspaceDir: string;
}

interface CurrentCandidate {
  readonly row: SessionStorageRow;
  readonly record: SessionRecord;
}

type DefinitionRepair =
  | ReturnType<typeof serializeSessionAgentDefinition>
  | 'legacy-agent-definition'
  | 'invalid-agent-definition'
  | 'agent-definition-mismatch'
  | undefined;

function repairCandidateInTransaction(input: CandidateTransactionInput): 'repaired' | string {
  const current = readCurrentCandidate(input);
  if (typeof current === 'string') return current;

  const nextDefinition = readDefinitionRepair(input.tx, current.record, input.agent);
  if (typeof nextDefinition === 'string') return nextDefinition;

  writeCandidateRepair(input.tx, current, nextDefinition);
  return 'repaired';
}

function readCurrentCandidate(input: CandidateTransactionInput): CurrentCandidate | string {
  const row = input.tx
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, input.record.sessionId))
    .get();
  if (!row) return 'session-missing';

  const current = decodeSessionRow(row);
  const changedReason = changedCandidateReason(input, current);
  return changedReason || { row, record: current };
}

function changedCandidateReason(
  input: Omit<CandidateTransactionInput, 'tx'>,
  current: SessionRecord,
): string | undefined {
  const staticReason = staticSkipReason(current);
  if (staticReason) return `changed-${staticReason}`;
  if (changedAgentRootReason(current, input.record, input.agent)) return 'changed-agent-root';
  const workspaceReason = projectWorkspaceReason({
    record: current,
    agent: input.agent,
    dataDir: input.dataDir,
    defaultWorkspaceDir: input.defaultWorkspaceDir,
  });
  if (workspaceReason) return `changed-${workspaceReason}`;
  return undefined;
}

function changedAgentRootReason(
  current: SessionRecord,
  original: SessionRecord,
  agent: RootAgentRecord,
): boolean {
  return (
    current.agentName !== agent.agentName ||
    current.sessionId !== agent.rootSessionId ||
    !samePath(current.workspaceDir, original.workspaceDir)
  );
}

function readDefinitionRepair(
  tx: AppDbTransaction,
  current: SessionRecord,
  agent: RootAgentRecord,
): DefinitionRepair {
  const definitionRow = tx
    .select()
    .from(sessionAgentDefinitions)
    .where(eq(sessionAgentDefinitions.sessionId, current.sessionId))
    .get();
  return definitionRow ? repairDefinition({ definitionRow, current, agent }) : undefined;
}

function writeCandidateRepair(
  tx: AppDbTransaction,
  current: CurrentCandidate,
  nextDefinition: Exclude<DefinitionRepair, string>,
): void {
  const projection = encodeSessionRow(
    { ...current.record, isDefaultWorkspace: false },
    { preservedRecordJson: current.row.recordJson, projectId: current.row.projectId },
  );
  tx
    .update(sessions)
    .set({
      projectWorkspaceDir: projection.projectWorkspaceDir,
      isDefaultWorkspace: projection.isDefaultWorkspace,
    })
    .where(eq(sessions.sessionId, current.record.sessionId))
    .run();
  writeDefinitionRepair(tx, current.record.sessionId, nextDefinition);
}

function writeDefinitionRepair(
  tx: AppDbTransaction,
  sessionId: string,
  nextDefinition: Exclude<DefinitionRepair, string>,
): void {
  if (!nextDefinition) return;
  tx
    .update(sessionAgentDefinitions)
    .set({ definitionJson: nextDefinition.definitionJson })
    .where(eq(sessionAgentDefinitions.sessionId, sessionId))
    .run();
}

function repairDefinition(input: {
  readonly definitionRow: typeof sessionAgentDefinitions.$inferSelect;
  readonly current: SessionRecord;
  readonly agent: RootAgentRecord;
}): DefinitionRepair {
  let definition: ReturnType<typeof decodeSessionAgentDefinition>['definition'];
  try {
    definition = decodeSessionAgentDefinition(input.definitionRow).definition;
  } catch {
    return 'invalid-agent-definition';
  }
  if (!isCurrentSessionAgentDefinition(definition)) return 'legacy-agent-definition';
  if (
    definition.exactOwnerName !== input.agent.agentName ||
    definition.project.isDefaultWorkspace !== true ||
    !samePath(definition.project.workspaceDir, input.current.workspaceDir)
  ) {
    return 'agent-definition-mismatch';
  }
  return serializeSessionAgentDefinition({
    definition: {
      ...definition,
      project: { ...definition.project, isDefaultWorkspace: false },
    },
  });
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalizeAbsolutePath(left);
  const normalizedRight = normalizeAbsolutePath(right);
  if (!normalizedLeft || !normalizedRight || pathFlavor(normalizedLeft) !== pathFlavor(normalizedRight)) {
    return false;
  }
  return pathFlavor(normalizedLeft) === pathFlavor('C:\\')
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isWithinDirectory(value: string, directory: string): boolean {
  if (pathFlavor(value) !== pathFlavor(directory)) return false;
  const windows = pathFlavor(value) === pathFlavor('C:\\');
  const candidate = windows ? value.toLowerCase() : value;
  const parent = windows ? directory.toLowerCase() : directory;
  const separator = windows ? '\\' : '/';
  return candidate === parent || candidate.startsWith(`${parent}${separator}`);
}

function skip(summary: MutableSummary, reason: string): void {
  summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1;
}

function reportSummary(
  diagnostics: RootProjectHistoryRepairDiagnostics | undefined,
  summary: MutableSummary,
): RootProjectHistoryRepairSummary {
  const result: RootProjectHistoryRepairSummary = {
    scanned: summary.scanned,
    repaired: summary.repaired,
    repairedSessionIds: [...summary.repairedSessionIds],
    failed: summary.failed,
    skipped: { ...summary.skipped },
  };
  try {
    diagnostics?.reportSummary(result);
  } catch {
    // Startup repair diagnostics must not affect SessionSystem readiness.
  }
  return result;
}

function reportFailure(
  diagnostics: RootProjectHistoryRepairDiagnostics | undefined,
  entry: RootProjectHistoryRepairFailure,
): void {
  try {
    diagnostics?.reportFailure(entry);
  } catch {
    // Startup repair diagnostics must not affect subsequent candidates.
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
