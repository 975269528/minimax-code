import path from 'node:path';

import type {
  LocalTurnDiffRecord,
  LocalTurnDiffRewindFilePlan,
  LocalTurnDiffRewindPlan,
  LocalTurnDiffRewindReceipt,
  LocalTurnDiffSnapshotEntry,
  LocalTurnDiffStore,
} from '../persistence/ports.js';
import {
  applyFileIfSafe,
  assertSnapshotComplete,
  fileMatches,
  LocalTurnDiffRewindPreflightError,
  logFileSkip,
  logSkippedFile,
  planKey,
  requireSafeRelativePath,
  sameSnapshot,
  type LocalTurnDiffRewindPreflightErrorCode,
} from './diff-rewind-files.js';

export {
  LocalTurnDiffRewindPreflightError,
  type LocalTurnDiffRewindPreflightErrorCode,
} from './diff-rewind-files.js';

export interface LocalTurnDiffRewindInput {
  readonly operationId: string;
  readonly sessionId: string;
}

export interface LocalTurnDiffRewindPreflightInput extends LocalTurnDiffRewindInput {
  readonly fullyDeletedTurnIds: readonly string[];
  readonly partiallyRetainedTurnIds: readonly string[];
}

export type LocalTurnDiffRewindFileAction = 'modified' | 'created' | 'deleted';
export type LocalTurnDiffRewindFileStatus = 'ready' | 'skipped';

export interface LocalTurnDiffRewindPreviewFile {
  readonly file: string;
  readonly action: LocalTurnDiffRewindFileAction;
  readonly status: LocalTurnDiffRewindFileStatus;
}

export interface LocalTurnDiffRewindPreviewTurn {
  readonly turnId: string;
  readonly files: readonly LocalTurnDiffRewindPreviewFile[];
}

export interface LocalTurnDiffRewindPreview {
  readonly turns: readonly LocalTurnDiffRewindPreviewTurn[];
}

export interface LocalTurnDiffRewindPreviewInput {
  readonly sessionId: string;
  readonly turnIds: readonly string[];
  readonly partiallyRetainedTurnIds: readonly string[];
}

/** Operation-scoped best-effort Undo. Every file is checked immediately before its own write. */
export class LocalTurnDiffRewindCapability {
  constructor(private readonly store: LocalTurnDiffStore) {}

  async preview(input: LocalTurnDiffRewindPreviewInput): Promise<LocalTurnDiffRewindPreview> {
    const records = await affectedRecords(this.store, input.sessionId, input.turnIds);
    const analysis = analyzeRecords(records, new Set(input.partiallyRetainedTurnIds));
    const matches = new Map(
      await Promise.all(
        analysis.files.map(async (file) => [planKey(file), await fileMatches(file)] as const),
      ),
    );
    return { turns: projectPreviewTurns(analysis, matches) };
  }

  async preflight(input: LocalTurnDiffRewindPreflightInput): Promise<void> {
    const existing = await this.store.getRewindOperation(input.operationId);
    if (existing) {
      assertPlanIdentity(existing.plan, input);
      return;
    }
    await this.store.putRewindPlan(await buildPlan(this.store, input));
  }

  async apply(input: LocalTurnDiffRewindInput): Promise<LocalTurnDiffRewindReceipt> {
    const operation = await this.store.getRewindOperation(input.operationId);
    if (!operation || operation.plan.sessionId !== input.sessionId) {
      throw new LocalTurnDiffRewindPreflightError(
        'request-conflict',
        'Turn diff rewind plan is missing or belongs to another Session',
      );
    }
    if (operation.receipt) return successfulReceipt(operation.receipt);
    if (operation.plan.turnIds.length === 0) {
      return this.persist(input.operationId, { status: 'no-diff' });
    }

    const results = await Promise.all(operation.plan.files.map(applyFileIfSafe));
    const appliedTurnIds = new Set(
      results.flatMap((result) => (result.status === 'applied' ? result.turnIds : [])),
    );
    const skippedTurnIds = new Set([
      ...(operation.plan.skippedTurnIds ?? []),
      ...results.flatMap((result, index) => {
        if (result.status === 'applied') return [];
        const file = operation.plan.files[index];
        if (file) logSkippedFile(input, file, result);
        return file?.turnIds ?? [];
      }),
    ]);
    const revertedTurnIds = operation.plan.turnIds.filter((turnId) => appliedTurnIds.has(turnId));
    const fullyRevertedTurnIds = revertedTurnIds.filter((turnId) => !skippedTurnIds.has(turnId));
    const fullyRevertedTurns = new Set(fullyRevertedTurnIds);
    const revertedChangeSetIds = operation.plan.changeSetIds.filter((_, index) => {
      const turnId = operation.plan.turnIds[index];
      return turnId !== undefined && fullyRevertedTurns.has(turnId);
    });

    await Promise.allSettled(
      revertedChangeSetIds.map((changeSetId) =>
        this.store.updateStatus(input.sessionId, changeSetId, 'reverted', Date.now()),
      ),
    );
    return this.persist(input.operationId, {
      status: 'rewound',
      revertedTurnIds: fullyRevertedTurnIds,
    });
  }

  deleteTurns(input: { readonly sessionId: string; readonly turnIds: readonly string[] }) {
    return this.store.deleteTurns(input.sessionId, input.turnIds);
  }

  private async persist(
    operationId: string,
    receipt: LocalTurnDiffRewindReceipt,
  ): Promise<LocalTurnDiffRewindReceipt> {
    await this.store.putRewindReceipt(operationId, receipt);
    return receipt;
  }
}

interface InternalPreviewFile extends LocalTurnDiffRewindPreviewFile {
  readonly key: string;
}

interface RewindAnalysis {
  readonly files: readonly LocalTurnDiffRewindFilePlan[];
  readonly skippedTurnIds: readonly string[];
  readonly turns: readonly {
    readonly turnId: string;
    readonly files: readonly InternalPreviewFile[];
  }[];
}

function projectPreviewTurns(
  analysis: RewindAnalysis,
  matches: ReadonlyMap<string, boolean>,
): LocalTurnDiffRewindPreviewTurn[] {
  const plans = new Map(analysis.files.map((file) => [planKey(file), file] as const));
  const projected = new Set<string>();
  return analysis.turns.map((turn) => ({
    turnId: turn.turnId,
    files: turn.files.flatMap((file) => {
      if (projected.has(file.key)) return [];
      projected.add(file.key);
      const plan = plans.get(file.key);
      if (!plan) return [{ file: file.file, action: file.action, status: 'skipped' as const }];
      if (sameSnapshot(plan.target, plan.expected)) return [];
      return [
        {
          file: plan.file,
          action: rewindAction(plan.target, plan.expected),
          status: matches.get(file.key) === true ? ('ready' as const) : ('skipped' as const),
        },
      ];
    }),
  }));
}

async function buildPlan(
  store: LocalTurnDiffStore,
  input: LocalTurnDiffRewindPreflightInput,
): Promise<LocalTurnDiffRewindPlan> {
  const records = await affectedRecords(store, input.sessionId, [
    ...input.fullyDeletedTurnIds,
    ...input.partiallyRetainedTurnIds,
  ]);
  const analysis = analyzeRecords(records, new Set(input.partiallyRetainedTurnIds));
  logPlanningSkips(input, analysis);
  return {
    schemaVersion: 1,
    operationId: input.operationId,
    sessionId: input.sessionId,
    requestedTurnIds: [...new Set(input.fullyDeletedTurnIds)].sort(),
    turnIds: records.map((record) => record.turnId),
    changeSetIds: records.map((record) => record.changeSetId),
    files: analysis.files,
    skippedTurnIds: analysis.skippedTurnIds,
  };
}

async function affectedRecords(
  store: LocalTurnDiffStore,
  sessionId: string,
  turnIds: readonly string[],
): Promise<LocalTurnDiffRecord[]> {
  const requested = new Set(turnIds);
  return (await store.listBySession(sessionId))
    .filter((record) => requested.has(record.turnId) && record.status === 'active')
    .sort(
      (left, right) =>
        right.capturedAtMs - left.capturedAtMs || right.changeSetId.localeCompare(left.changeSetId),
    );
}

function analyzeRecords(
  records: readonly LocalTurnDiffRecord[],
  partiallyRetainedTurnIds: ReadonlySet<string>,
): RewindAnalysis {
  const files = new Map<string, LocalTurnDiffRewindFilePlan>();
  const rejectedKeys = new Set<string>();
  const skippedTurnIds = new Set<string>();
  const previewByKey = new Map<string, InternalPreviewFile[]>();
  const turns = records.map((record) => {
    const previewFiles: InternalPreviewFile[] = [];
    if (
      partiallyRetainedTurnIds.has(record.turnId) ||
      !record.undoable ||
      !record.undo ||
      record.undo.length === 0
    ) {
      skippedTurnIds.add(record.turnId);
      return {
        turnId: record.turnId,
        files: fallbackPreviewFiles(record, 'skipped'),
      };
    }

    const recordPaths = new Set<string>();
    record.undo.forEach((entry) => {
      const action = rewindAction(entry.before, entry.after);
      const analyzed = analyzeEntry(record, entry, recordPaths, files, rejectedKeys);
      const preview: InternalPreviewFile = {
        key: analyzed.key,
        file: entry.file,
        action,
        status: analyzed.status,
      };
      previewFiles.push(preview);
      if (analyzed.key) {
        const current = previewByKey.get(analyzed.key) ?? [];
        current.push(preview);
        previewByKey.set(analyzed.key, current);
      }
      if (analyzed.status === 'skipped') skippedTurnIds.add(record.turnId);
      if (analyzed.rejectKey) {
        rejectedKeys.add(analyzed.key);
        files.delete(analyzed.key);
        previewByKey
          .get(analyzed.key)
          ?.forEach((file) => Object.assign(file, { status: 'skipped' as const }));
        skippedTurnIds.add(record.turnId);
      }
    });
    return { turnId: record.turnId, files: previewFiles };
  });
  return {
    files: [...files.values()].sort((left, right) => planKey(left).localeCompare(planKey(right))),
    skippedTurnIds: [...skippedTurnIds],
    turns,
  };
}

function analyzeEntry(
  record: LocalTurnDiffRecord,
  entry: NonNullable<LocalTurnDiffRecord['undo']>[number],
  recordPaths: Set<string>,
  files: Map<string, LocalTurnDiffRewindFilePlan>,
  rejectedKeys: ReadonlySet<string>,
): {
  readonly key: string;
  readonly status: LocalTurnDiffRewindFileStatus;
  readonly rejectKey: boolean;
} {
  let file: string;
  const fallbackKey = previewFileKey(record.workspaceDir, entry.file);
  try {
    file = requireSafeRelativePath(entry.file);
    assertSnapshotComplete(entry.before, file, true);
    assertSnapshotComplete(entry.after, file, false);
  } catch {
    return { key: fallbackKey, status: 'skipped', rejectKey: false };
  }
  const key = previewFileKey(record.workspaceDir, file);
  if (recordPaths.has(file) || rejectedKeys.has(key)) {
    return { key, status: 'skipped', rejectKey: true };
  }
  recordPaths.add(file);
  const current = files.get(key);
  if (current && !sameSnapshot(current.target, entry.after)) {
    return { key, status: 'skipped', rejectKey: true };
  }
  files.set(key, {
    workspaceDir: path.resolve(record.workspaceDir),
    file,
    expected: current?.expected ?? entry.after,
    target: entry.before,
    turnIds: [...(current?.turnIds ?? []), record.turnId],
  });
  return { key, status: 'ready', rejectKey: false };
}

function fallbackPreviewFiles(
  record: LocalTurnDiffRecord,
  status: LocalTurnDiffRewindFileStatus,
): InternalPreviewFile[] {
  return record.fileChanges.map((change) => ({
    key: previewFileKey(record.workspaceDir, change.file),
    file: change.file,
    action:
      change.status === 'added' ? 'created' : change.status === 'deleted' ? 'deleted' : 'modified',
    status,
  }));
}

function previewFileKey(workspaceDir: string, file: string): string {
  return `${path.resolve(workspaceDir)}\0${file.replaceAll('\\', '/')}`;
}

function rewindAction(
  before: LocalTurnDiffSnapshotEntry,
  after: LocalTurnDiffSnapshotEntry,
): LocalTurnDiffRewindFileAction {
  if (!before.exists && after.exists) return 'created';
  if (before.exists && !after.exists) return 'deleted';
  return 'modified';
}

function assertPlanIdentity(
  plan: LocalTurnDiffRewindPlan,
  input: LocalTurnDiffRewindPreflightInput,
): void {
  const expectedTurns = [...new Set(input.fullyDeletedTurnIds)].sort();
  if (plan.sessionId !== input.sessionId || !sameStrings(plan.requestedTurnIds, expectedTurns)) {
    preflightError('request-conflict', 'Operation ID was already used for another rewind plan');
  }
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[]): boolean {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}

function logPlanningSkips(
  input: LocalTurnDiffRewindPreflightInput,
  analysis: RewindAnalysis,
): void {
  analysis.turns.forEach((turn) => {
    turn.files
      .filter((file) => file.status === 'skipped')
      .forEach((file) =>
        logFileSkip({
          operationId: input.operationId,
          sessionId: input.sessionId,
          file: file.file,
          turnIds: [turn.turnId],
          reason: 'plan-not-safe',
        }),
      );
  });
}

function successfulReceipt(receipt: LocalTurnDiffRewindReceipt): LocalTurnDiffRewindReceipt {
  return receipt.status === 'failed-after-rewind'
    ? { status: 'rewound', revertedTurnIds: receipt.revertedTurnIds }
    : receipt;
}

function preflightError(code: LocalTurnDiffRewindPreflightErrorCode, message: string): never {
  throw new LocalTurnDiffRewindPreflightError(code, message);
}
