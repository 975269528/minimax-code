import type {
  ForkOperationManifest,
  ForkOperationPort,
  ForkAssetPort,
  ForkDisplayPort,
  ForkResumeResult,
  ForkSessionPort,
  ForkSessionStatePort,
  ForkWorktreePort,
} from './conversation-fork-contracts.js';

export type RecoverableForkStage =
  | 'validated'
  | 'worktree-prepared'
  | 'session-created'
  | 'history-published'
  | 'display-assets-published'
  | 'worktree-reminder-published'
  | 'child-visible';

const RECOVERY_OWNER = `local-runtime-recovery:${process.pid}`;
const RECOVERY_LEASE_MS = 30_000;
const FORK_RECOVERY_RETRY_ERROR = {
  code: 'FORK_RECOVERY_FAILED',
  message: 'This Fork did not complete; retry with a new operation ID',
} as const;

export interface ForkRecoveryDependencies {
  readonly operations: Required<
    Pick<ForkOperationPort, 'listPending' | 'claim' | 'advanceClaimed' | 'failRecovery'>
  >;
  readonly sessions: Pick<ForkSessionPort, 'delete'>;
  readonly display: Pick<ForkDisplayPort, 'deleteSession'>;
  readonly assets?: Pick<ForkAssetPort, 'compensate'>;
  readonly state?: Pick<ForkSessionStatePort, 'compensate'>;
  readonly worktree?: Pick<ForkWorktreePort, 'cleanup'>;
  readonly resume?: (input: {
    readonly manifest: ForkOperationManifest;
    readonly stage: RecoverableForkStage;
    readonly advance: (input: {
      readonly stage: string;
      readonly manifest: ForkOperationManifest;
    }) => Promise<void>;
  }) => Promise<ForkResumeResult>;
}

/**
 * Application startup recovery never cleans resources without durable ownership proof. An
 * operation that cannot resume still reaches a terminal state so it cannot
 * permanently block its source Session.
 */
export async function recoverPendingForkOperations(deps: ForkRecoveryDependencies): Promise<void> {
  const pending = await deps.operations.listPending();
  for (const candidate of pending) {
    await recoverCandidate(deps, candidate);
  }
}

type PendingForkOperation = Awaited<
  ReturnType<ForkRecoveryDependencies['operations']['listPending']>
>[number];
type ClaimedForkOperation = NonNullable<
  Awaited<ReturnType<ForkRecoveryDependencies['operations']['claim']>>
>;

async function recoverCandidate(
  deps: ForkRecoveryDependencies,
  candidate: PendingForkOperation,
): Promise<void> {
  const claimed = await deps.operations.claim({
    operationId: candidate.operationId,
    owner: RECOVERY_OWNER,
    leaseMs: RECOVERY_LEASE_MS,
  });
  if (!claimed) return;
  const manifest = trustedManifestWithoutUnverifiedAssets(claimed.intent, candidate.operationId);
  if (!manifest) {
    await terminalizeRecoveryFailure(deps, {
      operationId: candidate.operationId,
      expectedRevision: claimed.revision,
      error: {
        code: 'RECOVERY_MANIFEST_UNTRUSTED',
        message: 'Fork recovery requires a durable ownership manifest',
      },
    });
    return;
  }
  await discardUnverifiedAssetProjection(deps, claimed.intent, manifest);
  await recoverClaimed(deps, candidate.operationId, claimed, manifest);
}

async function discardUnverifiedAssetProjection(
  deps: ForkRecoveryDependencies,
  persisted: ForkOperationManifest | undefined,
  trusted: ForkOperationManifest,
): Promise<void> {
  const childSessionId = trusted.childSessionId;
  const assets = deps.assets;
  if (
    persisted?.assets === undefined ||
    trusted.assets !== undefined ||
    !childSessionId ||
    !assets
  ) {
    return;
  }
  await cleanupSucceeded(() => assets.compensate({ targetSessionId: childSessionId }));
}

async function recoverClaimed(
  deps: ForkRecoveryDependencies,
  operationId: string,
  claimed: ClaimedForkOperation,
  manifest: ForkOperationManifest,
): Promise<void> {
  const claim = { revision: claimed.revision };
  try {
    if (claimed.status === 'running') {
      await resumeClaimed(deps, {
        operationId,
        persistedStage: claimed.stage,
        manifest,
        claim,
      });
      return;
    }
    await compensateClaimed(deps, operationId, manifest, claim.revision);
  } catch {
    await terminalizeRecoveryFailure(deps, {
      operationId,
      expectedRevision: claim.revision,
      manifest,
      cleanupOwned: true,
      error: FORK_RECOVERY_RETRY_ERROR,
    });
  }
}

async function resumeClaimed(
  deps: ForkRecoveryDependencies,
  input: {
    readonly operationId: string;
    readonly persistedStage: string | null;
    readonly manifest: ForkOperationManifest;
    readonly claim: { revision: number };
  },
): Promise<void> {
  const stage = asRecoverableForkStage(input.persistedStage);
  if (!stage || !deps.resume) {
    await terminalizeRecoveryFailure(deps, {
      operationId: input.operationId,
      expectedRevision: input.claim.revision,
      manifest: input.manifest,
      cleanupOwned: true,
      error: {
        code: 'RECOVERY_STAGE_UNSUPPORTED',
        message: 'Fork recovery cannot resume this persisted stage',
      },
    });
    return;
  }
  const advanceClaimed = deps.operations.advanceClaimed;
  const resumed = await deps.resume({
    manifest: input.manifest,
    stage,
    advance: async (next) => {
      const advanced = await advanceClaimed({
        operationId: input.operationId,
        owner: RECOVERY_OWNER,
        expectedRevision: input.claim.revision,
        status: 'running',
        stage: next.stage,
        intent: next.manifest,
        leaseMs: RECOVERY_LEASE_MS,
      });
      if (!advanced) throw new Error('Fork recovery lost its operation claim');
      input.claim.revision = advanced.revision;
    },
  });
  const advanced = await advanceClaimed({
    operationId: input.operationId,
    owner: RECOVERY_OWNER,
    expectedRevision: input.claim.revision,
    status: 'completed',
    stage: 'published',
    intent: resumed.manifest,
    result: resumed.result,
  });
  if (!advanced) {
    throw new Error('Fork recovery lost its operation claim before terminal transition');
  }
}

async function compensateClaimed(
  deps: ForkRecoveryDependencies,
  operationId: string,
  manifest: ForkOperationManifest,
  expectedRevision: number,
): Promise<void> {
  const cleaned = await compensateManifestBestEffort(deps, manifest);
  await markRecoveryTerminal(deps, {
    operationId,
    expectedRevision,
    stage: cleaned ? 'compensated' : 'recovery-failed',
    manifest,
    error: FORK_RECOVERY_RETRY_ERROR,
  });
}

interface TerminalRecoveryInput {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly error: { readonly code: string; readonly message: string };
  readonly manifest?: ForkOperationManifest;
  readonly cleanupOwned?: boolean;
}

async function terminalizeRecoveryFailure(
  deps: ForkRecoveryDependencies,
  input: TerminalRecoveryInput,
): Promise<void> {
  if (input.cleanupOwned && input.manifest) {
    await compensateManifestBestEffort(deps, input.manifest);
  }
  await markRecoveryTerminal(deps, {
    ...input,
    stage: 'recovery-failed',
  });
}

async function markRecoveryTerminal(
  deps: ForkRecoveryDependencies,
  input: TerminalRecoveryInput & { readonly stage: 'compensated' | 'recovery-failed' },
): Promise<void> {
  const advanceClaimed = deps.operations.advanceClaimed;
  const advanced = await advanceClaimed({
    operationId: input.operationId,
    owner: RECOVERY_OWNER,
    expectedRevision: input.expectedRevision,
    status: 'failed',
    stage: input.stage,
    ...(input.manifest ? { intent: input.manifest } : {}),
    error: input.error,
  });
  if (advanced) return;
  await deps.operations.failRecovery({
    operationId: input.operationId,
    stage: input.stage,
    ...(input.manifest ? { intent: input.manifest } : {}),
    error: input.error,
  });
}

export function asRecoverableForkStage(value: string | null): RecoverableForkStage | undefined {
  switch (value) {
    case 'validated':
    case 'worktree-prepared':
    case 'session-created':
    case 'history-published':
    case 'display-assets-published':
    case 'worktree-reminder-published':
    case 'child-visible':
      return value;
    default:
      return undefined;
  }
}
function trustedManifestWithoutUnverifiedAssets(
  value: ForkOperationManifest | undefined,
  operationId: string,
): ForkOperationManifest | undefined {
  const sourceSessionId = value?.source?.sessionId;
  if (
    value?.schemaVersion !== 1 ||
    typeof value.request?.operationId !== 'string' ||
    value.request.operationId !== operationId ||
    typeof sourceSessionId !== 'string' ||
    sourceSessionId.length === 0 ||
    (value.childSessionId !== undefined && value.childSessionId.length === 0)
  ) {
    return undefined;
  }
  return isTrustedAssetManifest(value.assets) ? value : { ...value, assets: undefined };
}

function isTrustedAssetManifest(assets: unknown): assets is ForkOperationManifest['assets'] {
  if (assets === undefined) return true;
  if (typeof assets !== 'object' || assets === null || Array.isArray(assets)) return false;
  const value = assets as Record<string, unknown>;
  const mode = value['mode'];
  const targetRoot = value['targetRoot'];
  const copiedPaths = value['copiedPaths'];
  if (
    !isTrustedAssetCopyMode(mode) ||
    !isTrustedOptionalTargetRoot(targetRoot) ||
    !isTrustedCopiedPaths(copiedPaths)
  )
    return false;
  return isTrustedAssetCopyShape(mode, targetRoot, copiedPaths);
}

function isTrustedAssetCopyMode(value: unknown): boolean {
  return value === undefined || value === 'records-only' || value === 'workspace-copy';
}

function isTrustedOptionalTargetRoot(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isTrustedCopiedPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((path) => typeof path === 'string' && path.length > 0);
}

function isTrustedAssetCopyShape(
  mode: unknown,
  targetRoot: unknown,
  copiedPaths: readonly string[],
): boolean {
  if (mode === 'records-only') return targetRoot === undefined && copiedPaths.length === 0;
  if (mode === 'workspace-copy') return typeof targetRoot === 'string';
  return true;
}

async function compensateManifestBestEffort(
  deps: ForkRecoveryDependencies,
  manifest: ForkOperationManifest,
): Promise<boolean> {
  const childClean = await compensateChildBestEffort(deps, manifest);
  const worktreeClean = await compensateWorktreeBestEffort(deps, manifest);
  return childClean && worktreeClean;
}

async function compensateChildBestEffort(
  deps: ForkRecoveryDependencies,
  manifest: ForkOperationManifest,
): Promise<boolean> {
  const childSessionId = manifest.childSessionId;
  if (!childSessionId) return true;
  const assets = manifest.assets;
  const assetPort = deps.assets;
  const assetsClean =
    !assets || !assetPort
      ? !assets
      : await cleanupSucceeded(() =>
          assetPort.compensate({
            targetSessionId: childSessionId,
            ...(assets.mode ? { mode: assets.mode } : {}),
            ...(assets.targetRoot ? { targetRoot: assets.targetRoot } : {}),
            copiedPaths: assets.copiedPaths,
          }),
        );
  const displayClean = await cleanupSucceeded(() => deps.display.deleteSession(childSessionId));
  const state = deps.state;
  const stateClean = state
    ? await cleanupSucceeded(() => state.compensate({ targetSessionId: childSessionId }))
    : true;
  const sessionClean = await cleanupSucceeded(() => deps.sessions.delete(childSessionId));
  return assetsClean && displayClean && stateClean && sessionClean;
}

async function compensateWorktreeBestEffort(
  deps: ForkRecoveryDependencies,
  manifest: ForkOperationManifest,
): Promise<boolean> {
  if (!manifest.request.isolatedWorktree) return true;
  const worktree = manifest.worktree;
  const worktreePort = deps.worktree;
  // Worktree cleanup is intentionally not attempted without an ownership token.
  // The persisted ownership record is validated by the production adapter before deletion.
  if (!worktree?.ownershipToken || !worktreePort) return false;
  return cleanupSucceeded(() =>
    worktreePort.cleanup({
      operationId: manifest.request.operationId,
      workspaceDir: worktree.workspaceDir,
      ownershipToken: worktree.ownershipToken,
    }),
  );
}

async function cleanupSucceeded(cleanup: () => Promise<void>): Promise<boolean> {
  try {
    await cleanup();
    return true;
  } catch {
    return false;
  }
}
