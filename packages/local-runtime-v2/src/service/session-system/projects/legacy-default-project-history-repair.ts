import { and, eq } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { projects } from '../../../infra/db/schema/projects.js';
import { sessionAgentDefinitions, sessions } from '../../../infra/db/schema/sessions.js';
import {
  decodeSessionAgentDefinition,
  isCurrentSessionAgentDefinition,
  serializeSessionAgentDefinition,
} from '../sessions/repo/agent-binding.js';
import {
  CURRENT_SESSION_COLUMNAR_VERSION,
  decodeSessionRow,
} from '../sessions/repo/drizzle/codec.js';
import type { SessionRecord } from '../sessions/repo/contract.js';
import type { RootAgentPort, RootAgentRecord } from '../sessions/root/root-invariant-service.js';
import { normalizeAbsolutePath, pathFlavor } from '../shared/path-normalization.js';
import {
  canonicalProjectWorkspaceDir,
  isAgentInternalDefaultWorkspaceDir,
  isSessionDefaultWorkspaceDir,
} from '../shared/workspace.js';

export interface LegacyDefaultProjectHistoryRepairSummary {
  readonly scanned: number;
  readonly repaired: number;
  readonly repairedSessionIds: readonly string[];
  readonly failed: number;
  readonly skipped: Readonly<Record<string, number>>;
}

interface LegacyDefaultProjectHistoryRepairFailure {
  readonly stage: 'scan' | 'candidate';
  readonly reason: 'repair-failed';
  readonly sessionId?: string;
  readonly agentName?: string;
}

/** Diagnostics deliberately expose stable codes and never workspace paths. */
export interface LegacyDefaultProjectHistoryRepairDiagnostics {
  reportSummary(summary: LegacyDefaultProjectHistoryRepairSummary): void;
  reportFailure(entry: LegacyDefaultProjectHistoryRepairFailure): void;
}

export interface LegacyDefaultProjectHistoryRepairInput {
  readonly db: AppDb;
  readonly dataDir: string;
  readonly defaultWorkspaceDir: () => string;
  readonly rootAgents: RootAgentPort;
  /** Existing Agent config read; Custom root repairs require its current incarnation. */
  readonly getAgentOwnerIdentity?: (agentName: string) => Promise<CurrentOwnerIdentity | undefined>;
  readonly diagnostics?: LegacyDefaultProjectHistoryRepairDiagnostics;
}

interface CurrentOwnerIdentity {
  readonly exactOwnerName: string;
  readonly ownerKind: 'builtin' | 'custom';
  readonly ownerInstanceId?: string;
}

/**
 * Repairs only historical roots whose workspace Project can be proven to be a
 * runtime-owned default workspace. This is runtime repair, not a migration:
 * rows that remain ambiguous are revisited safely on a later startup.
 */
export async function repairLegacyDefaultProjectHistory(
  input: LegacyDefaultProjectHistoryRepairInput,
): Promise<LegacyDefaultProjectHistoryRepairSummary> {
  const summary = createSummary();
  let rows: readonly SessionStorageRow[];
  try {
    rows = input.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.columnarVersion, CURRENT_SESSION_COLUMNAR_VERSION),
          eq(sessions.runtime, 'pi-agent'),
          eq(sessions.sessionType, 'root'),
          eq(sessions.sessionKind, 'conversation'),
          eq(sessions.archived, 0),
          eq(sessions.isDefaultWorkspace, 0),
        ),
      )
      .all();
  } catch {
    summary.failed += 1;
    reportFailure(input.diagnostics, { stage: 'scan', reason: 'repair-failed' });
    return reportSummary(input.diagnostics, summary);
  }

  const context = createContext(input);
  for (const row of rows) {
    summary.scanned += 1;
    const outcome = await repairCandidate({ input, row, context });
    recordOutcome(summary, input.diagnostics, outcome);
  }
  return reportSummary(input.diagnostics, summary);
}

interface RepairContext {
  readonly dataDir: string;
  readonly defaultWorkspaceDir?: string;
}

type SessionStorageRow = typeof sessions.$inferSelect;
type AppDbTransaction = Parameters<Parameters<AppDb['transaction']>[0]>[0];

interface MutableSummary {
  scanned: number;
  repaired: number;
  repairedSessionIds: string[];
  failed: number;
  skipped: Record<string, number>;
}

type CandidateOutcome =
  | { readonly kind: 'repaired'; readonly sessionId: string }
  | { readonly kind: 'skipped'; readonly reason: string }
  | {
      readonly kind: 'failed';
      readonly failure: LegacyDefaultProjectHistoryRepairFailure;
    };

interface RepairProof {
  readonly record: SessionRecord;
  readonly agent: RootAgentRecord;
  readonly owner: CurrentOwnerIdentity;
  readonly context: RepairContext;
}

function createSummary(): MutableSummary {
  return { scanned: 0, repaired: 0, repairedSessionIds: [], failed: 0, skipped: {} };
}

function createContext(input: LegacyDefaultProjectHistoryRepairInput): RepairContext | undefined {
  const dataDir = normalizeAbsolutePath(input.dataDir);
  if (!dataDir) return undefined;
  try {
    const defaultWorkspaceDir = normalizeAbsolutePath(input.defaultWorkspaceDir());
    return { dataDir, ...(defaultWorkspaceDir ? { defaultWorkspaceDir } : {}) };
  } catch {
    return { dataDir };
  }
}

async function repairCandidate(input: {
  readonly input: LegacyDefaultProjectHistoryRepairInput;
  readonly row: SessionStorageRow;
  readonly context: RepairContext | undefined;
}): Promise<CandidateOutcome> {
  try {
    const proof = await readRepairProof(input);
    if ('kind' in proof) return proof;

    const result = input.input.db.transaction(
      (tx) => repairInTransaction({ tx, row: input.row, ...proof }),
      { behavior: 'immediate' },
    );
    return result === 'repaired'
      ? { kind: 'repaired', sessionId: proof.record.sessionId }
      : { kind: 'skipped', reason: result };
  } catch {
    return {
      kind: 'failed',
      failure: {
        stage: 'candidate',
        reason: 'repair-failed',
        sessionId: input.row.sessionId,
        ...(input.row.agentName ? { agentName: input.row.agentName } : {}),
      },
    };
  }
}

async function readRepairProof(input: {
  readonly input: LegacyDefaultProjectHistoryRepairInput;
  readonly row: SessionStorageRow;
  readonly context: RepairContext | undefined;
}): Promise<RepairProof | CandidateOutcome> {
  const record = decodeSessionRow(input.row);
  const staticReason = staticSkipReason(record);
  if (staticReason) return { kind: 'skipped', reason: staticReason };
  const context = input.context;
  if (!context) return { kind: 'skipped', reason: 'runtime-data-dir-unavailable' };
  if (!defaultWorkspaceEvidence(record, context)) {
    return { kind: 'skipped', reason: 'workspace-not-default-evidence' };
  }
  const agent = await input.input.rootAgents.get(record.agentName);
  if (!agent) return { kind: 'skipped', reason: 'agent-owner-mismatch' };
  const agentReason = matchingAgentReason(record, agent);
  if (agentReason) return { kind: 'skipped', reason: agentReason };
  // SessionSystem.ready runs before the management port binds, so no Agent
  // mutation surface is live between this current-owner read and BEGIN IMMEDIATE.
  const owner = await input.input.getAgentOwnerIdentity?.(record.agentName);
  if (!owner) return { kind: 'skipped', reason: 'agent-owner-identity-unavailable' };
  const ownerReason = matchingCurrentOwnerReason(agent, owner);
  return ownerReason ? { kind: 'skipped', reason: ownerReason } : { record, agent, owner, context };
}

function staticSkipReason(record: SessionRecord): string | undefined {
  if (!isEligibleHistoricalRoot(record)) return 'unproven-session';
  if (record.runLocation !== undefined) return 'explicit-run-location';
  if (!isRepairSource(record)) return 'unproven-source';
  return canonicalProjectWorkspaceDir(record.workspaceDir) ? undefined : 'workspace-not-project';
}

function isEligibleHistoricalRoot(record: SessionRecord): boolean {
  return (
    record.runtime === 'pi-agent' &&
    record.sessionType === 'root' &&
    record.sessionKind === 'conversation' &&
    !record.archived &&
    record.parentSessionId === null &&
    record.isDefaultWorkspace === false
  );
}

function isRepairSource(record: SessionRecord): boolean {
  return record.sessionOrigin === 'legacy-opencode' || record.origin === 'root-repair';
}

function matchingAgentReason(record: SessionRecord, agent: RootAgentRecord): string | undefined {
  if (agent.agentName !== record.agentName) return 'agent-owner-mismatch';
  return agent.rootSessionId === record.sessionId ? undefined : 'agent-root-mismatch';
}

function matchingCurrentOwnerReason(
  agent: RootAgentRecord,
  owner: CurrentOwnerIdentity,
): string | undefined {
  return owner.exactOwnerName === agent.agentName ? undefined : 'agent-owner-mismatch';
}

function defaultWorkspaceEvidence(record: SessionRecord, context: RepairContext): boolean {
  const workspaceDir = normalizeAbsolutePath(record.workspaceDir);
  if (!workspaceDir) return false;
  if (context.defaultWorkspaceDir && samePath(workspaceDir, context.defaultWorkspaceDir))
    return true;
  if (isSessionDefaultWorkspaceDir(workspaceDir, record.sessionId)) return true;
  const agentWorkspaceDir = pathFlavor(context.dataDir).join(
    context.dataDir,
    'agents',
    record.agentName,
    'workspace',
  );
  return isAgentInternalDefaultWorkspaceDir(workspaceDir, agentWorkspaceDir, record.agentName);
}

interface TransactionInput {
  readonly tx: AppDbTransaction;
  readonly record: SessionRecord;
  readonly row: SessionStorageRow;
  readonly agent: RootAgentRecord;
  readonly owner: CurrentOwnerIdentity;
  readonly context: RepairContext;
}

interface CurrentCandidate {
  readonly row: SessionStorageRow;
  readonly record: SessionRecord;
}

type SerializedDefinitionRepair = ReturnType<typeof serializeSessionAgentDefinition>;
type DefinitionRepairReason =
  | 'legacy-agent-definition'
  | 'invalid-agent-definition'
  | 'agent-definition-mismatch'
  | 'agent-definition-required-for-custom-owner'
  | 'agent-owner-instance-unavailable'
  | 'agent-owner-instance-mismatch';
type DefinitionRepair = SerializedDefinitionRepair | DefinitionRepairReason | undefined;
type CurrentFrozenDefinition = Extract<
  ReturnType<typeof decodeSessionAgentDefinition>['definition'],
  { readonly definitionVersion: 2 }
>;

function repairInTransaction(input: TransactionInput): 'repaired' | string {
  const current = readCurrentCandidate(input);
  if (typeof current === 'string') return current;
  const projectReason = currentWorkspaceProjectReason(input.tx, current);
  if (projectReason) return projectReason;
  const nextDefinition = readDefinitionRepair(input.tx, current.record, input.agent, input.owner);
  if (typeof nextDefinition === 'string') return nextDefinition;

  input.tx
    .update(sessions)
    .set({
      // Project triggers derive the default Project from this canonical pair.
      // workspaceDir remains historical execution evidence, not a Project mirror.
      projectWorkspaceDir: null,
      isDefaultWorkspace: 1,
    })
    .where(eq(sessions.sessionId, current.record.sessionId))
    .run();
  writeDefinitionRepair(input.tx, current.record.sessionId, nextDefinition);
  assertDefaultProjectAssignment(input.tx, current.record.sessionId);
  return 'repaired';
}

function readCurrentCandidate(input: TransactionInput): CurrentCandidate | string {
  const row = input.tx
    .select()
    .from(sessions)
    .where(eq(sessions.sessionId, input.record.sessionId))
    .get();
  if (!row) return 'session-missing';
  if (row.projectId !== input.row.projectId) return 'changed-project';

  const record = decodeSessionRow(row);
  const staticReason = staticSkipReason(record);
  if (staticReason) return `changed-${staticReason}`;
  if (
    record.agentName !== input.agent.agentName ||
    input.agent.rootSessionId !== record.sessionId ||
    input.owner.exactOwnerName !== input.agent.agentName
  ) {
    return 'changed-agent-root';
  }
  if (!samePath(record.workspaceDir, input.record.workspaceDir)) return 'changed-workspace';
  return defaultWorkspaceEvidence(record, input.context)
    ? { row, record }
    : 'changed-workspace-not-default-evidence';
}

function currentWorkspaceProjectReason(
  tx: AppDbTransaction,
  current: CurrentCandidate,
): string | undefined {
  const projectId = current.row.projectId;
  if (!isProjectId(projectId)) return 'workspace-project-missing';
  const project = tx.select().from(projects).where(eq(projects.projectId, projectId)).get();
  if (!project) return 'workspace-project-missing';
  if (project.projectKind !== 'workspace' || !project.workspaceDir) {
    return 'workspace-project-invalid';
  }
  const canonicalWorkspace = canonicalProjectWorkspaceDir(current.record.workspaceDir);
  if (!canonicalWorkspace || !current.row.projectWorkspaceDir) {
    return 'workspace-project-mismatch';
  }
  if (
    canonicalProjectWorkspaceDir(project.workspaceDir) !== project.workspaceDir ||
    !samePath(project.workspaceDir, canonicalWorkspace) ||
    !samePath(current.row.projectWorkspaceDir, canonicalWorkspace)
  ) {
    return 'workspace-project-mismatch';
  }
  return undefined;
}

function readDefinitionRepair(
  tx: AppDbTransaction,
  current: SessionRecord,
  agent: RootAgentRecord,
  owner: CurrentOwnerIdentity,
): DefinitionRepair {
  const definition = readCurrentDefinition(tx, current.sessionId, owner);
  if (definition === undefined || typeof definition === 'string') return definition;
  const mismatch = frozenDefinitionMismatchReason(definition, current, agent, owner);
  if (mismatch) return mismatch;
  return serializeSessionAgentDefinition({
    definition: {
      ...definition,
      project: { ...definition.project, isDefaultWorkspace: true },
    },
  });
}

function readCurrentDefinition(
  tx: AppDbTransaction,
  sessionId: string,
  owner: CurrentOwnerIdentity,
): CurrentFrozenDefinition | DefinitionRepairReason | undefined {
  const row = tx
    .select()
    .from(sessionAgentDefinitions)
    .where(eq(sessionAgentDefinitions.sessionId, sessionId))
    .get();
  if (!row) {
    return owner.ownerKind === 'custom' ? 'agent-definition-required-for-custom-owner' : undefined;
  }
  try {
    const definition = decodeSessionAgentDefinition(row).definition;
    return isCurrentSessionAgentDefinition(definition) ? definition : 'legacy-agent-definition';
  } catch {
    return 'invalid-agent-definition';
  }
}

function frozenDefinitionMismatchReason(
  definition: CurrentFrozenDefinition,
  current: SessionRecord,
  agent: RootAgentRecord,
  owner: CurrentOwnerIdentity,
): DefinitionRepairReason | undefined {
  if (
    definition.exactOwnerName !== agent.agentName ||
    definition.exactOwnerName !== owner.exactOwnerName ||
    definition.project.isDefaultWorkspace !== false ||
    !samePath(definition.project.workspaceDir, current.workspaceDir)
  ) {
    return 'agent-definition-mismatch';
  }
  return ownerInstanceMismatchReason(definition, owner);
}

function ownerInstanceMismatchReason(
  definition: CurrentFrozenDefinition,
  owner: CurrentOwnerIdentity,
): DefinitionRepairReason | undefined {
  if (owner.ownerKind !== 'custom') {
    return definition.ownerInstanceId === undefined ? undefined : 'agent-owner-instance-mismatch';
  }
  if (!definition.ownerInstanceId || !owner.ownerInstanceId) {
    return 'agent-owner-instance-unavailable';
  }
  return definition.ownerInstanceId === owner.ownerInstanceId
    ? undefined
    : 'agent-owner-instance-mismatch';
}

function writeDefinitionRepair(
  tx: AppDbTransaction,
  sessionId: string,
  nextDefinition: SerializedDefinitionRepair | undefined,
): void {
  if (!nextDefinition) return;
  tx.update(sessionAgentDefinitions)
    .set({ definitionJson: nextDefinition.definitionJson })
    .where(eq(sessionAgentDefinitions.sessionId, sessionId))
    .run();
}

function assertDefaultProjectAssignment(tx: AppDbTransaction, sessionId: string): void {
  const assignment = tx
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.sessionId, sessionId))
    .get();
  if (!isProjectId(assignment?.projectId)) {
    throw new Error('default-project-assignment-failed');
  }
  const project = tx
    .select()
    .from(projects)
    .where(eq(projects.projectId, assignment.projectId))
    .get();
  if (project?.projectKind !== 'default' || project.workspaceDir !== null) {
    throw new Error('default-project-assignment-failed');
  }
}

function isProjectId(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function recordOutcome(
  summary: MutableSummary,
  diagnostics: LegacyDefaultProjectHistoryRepairDiagnostics | undefined,
  outcome: CandidateOutcome,
): void {
  if (outcome.kind === 'repaired') {
    summary.repaired += 1;
    summary.repairedSessionIds.push(outcome.sessionId);
    return;
  }
  if (outcome.kind === 'skipped') {
    summary.skipped[outcome.reason] = (summary.skipped[outcome.reason] ?? 0) + 1;
    return;
  }
  summary.failed += 1;
  reportFailure(diagnostics, outcome.failure);
}

function reportSummary(
  diagnostics: LegacyDefaultProjectHistoryRepairDiagnostics | undefined,
  summary: MutableSummary,
): LegacyDefaultProjectHistoryRepairSummary {
  const result: LegacyDefaultProjectHistoryRepairSummary = {
    scanned: summary.scanned,
    repaired: summary.repaired,
    repairedSessionIds: [...summary.repairedSessionIds],
    failed: summary.failed,
    skipped: { ...summary.skipped },
  };
  try {
    diagnostics?.reportSummary(result);
  } catch {
    // Diagnostics must not affect SessionSystem readiness.
  }
  return result;
}

function reportFailure(
  diagnostics: LegacyDefaultProjectHistoryRepairDiagnostics | undefined,
  entry: LegacyDefaultProjectHistoryRepairFailure,
): void {
  try {
    diagnostics?.reportFailure(entry);
  } catch {
    // A broken sink must not prevent later candidate repairs.
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = normalizeAbsolutePath(left);
  const normalizedRight = normalizeAbsolutePath(right);
  if (
    !normalizedLeft ||
    !normalizedRight ||
    pathFlavor(normalizedLeft) !== pathFlavor(normalizedRight)
  ) {
    return false;
  }
  return pathFlavor(normalizedLeft) === pathFlavor('C:\\')
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}
