import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  acquireGenerationOperationFence,
  assertRuntimeOwnersStopped,
  isOwnersActiveError,
  withGenerationOperationLock,
  type GenerationOperationFence,
} from './rootless-v2-generation-fence.js';
import {
  assertCheckpointSourceBoundary,
  assertFreeSpace,
  chmodOwnerOnly,
  codedError,
  errorCode,
  fingerprintGeneration,
  generationPaths,
  pathExists,
  readAndValidateManifest,
  readJournal,
  shouldCopyCheckpointEntry,
  SOURCE_RELEASE,
  removeTransientEntries,
  syncDirectoryBestEffort,
  syncSwapParents,
  syncTree,
  TARGET_RELEASE,
  treeByteSize,
  tryCloneTree,
  writeJournal,
  writeJsonAtomically,
  writeNewJson,
  type GenerationManifest,
  type GenerationPaths,
  type SwapDirection,
} from './rootless-v2-generation-fs.js';

const CHECKPOINT_ERROR_CODE = 'ROOTLESS_V2_CHECKPOINT_FAILED';
const SWAP_ERROR_CODE = 'ROOTLESS_V2_GENERATION_SWAP_FAILED';
type Generation = 'previous' | 'upgraded';

interface RootlessV2CheckpointFaultHooks {
  beforePublish?(): void | Promise<void>;
}

/** @internal Deterministic fault seam exported only for focused tests. */
export interface RootlessV2SwapFaultHooks {
  afterFirstRename?(): void | Promise<void>;
  afterSecondRename?(): void | Promise<void>;
}

interface RootlessV2CheckpointResult {
  readonly created: boolean;
  readonly sourceAbsent: boolean;
}

interface RootlessV2GenerationSwapResult {
  readonly changed: boolean;
  readonly activeGeneration: Generation;
}

interface RootlessV2CheckpointOptions {
  readonly dataDir: string;
  readonly sourceRelease?: string;
  readonly targetRelease?: string;
  /** @internal Deterministic fault seam for checkpoint publication tests. */
  readonly faults?: RootlessV2CheckpointFaultHooks;
}

/**
 * Creates or verifies the checkpoint and releases the operation fence.
 * @internal Direct checkpoint entry point exported only for focused tests.
 */
export async function ensureRootlessV2Checkpoint(
  options: RootlessV2CheckpointOptions,
): Promise<RootlessV2CheckpointResult> {
  const paths = generationPaths(options.dataDir);
  let fence: GenerationOperationFence | undefined;
  try {
    fence = await acquireGenerationOperationFence(paths);
    return await ensureCheckpointUnderFence(options, paths, fence.assert);
  } catch (error) {
    throw checkpointError(error);
  } finally {
    await fence?.release();
  }
}

async function ensureCheckpointUnderFence(
  options: RootlessV2CheckpointOptions,
  paths: GenerationPaths,
  assertFence: () => void,
): Promise<RootlessV2CheckpointResult> {
  if (await pathExists(paths.root)) {
    const manifest = await readAndValidateManifest(paths, options);
    if (await pathExists(paths.journal)) {
      await assertRuntimeOwnersStopped(paths.dataDir);
      assertFence();
      await recoverSwapJournal(paths, manifest, assertFence);
    }
    const activeGeneration = await detectStableGeneration(paths, manifest);
    if (activeGeneration !== 'upgraded') {
      throw new Error('Previous generation is active; re-upgrade is required');
    }
    await verifyPreviousCheckpoint(paths, manifest);
    return { created: false, sourceAbsent: manifest.sourceAbsent };
  }

  await assertRuntimeOwnersStopped(paths.dataDir);
  assertFence();
  await removeStagingRoot(paths);
  await mkdir(paths.stagingRoot, { recursive: false, mode: 0o700 });
  await chmodOwnerOnly(paths.stagingRoot);
  try {
    const sourceAbsent = !(await pathExists(paths.dataDir));
    if (!sourceAbsent) {
      await assertCheckpointSourceBoundary(paths.dataDir);
      // Copy-on-write clone first: on APFS/btrfs it is milliseconds and needs
      // no free-space headroom, so the byte-size walk and space precheck only
      // run on the physical-copy fallback. Fingerprint verification below
      // guards both paths equally.
      const clone = await tryCloneTree(paths.dataDir, join(paths.stagingRoot, 'previous-data-dir'));
      if (clone.cloned) {
        // Platform cp may materialize FIFOs/sockets the fs.cp filter would
        // have skipped; strip them so both paths honor the same contract.
        await removeTransientEntries(join(paths.stagingRoot, 'previous-data-dir'));
      } else {
        const requiredBytes = await treeByteSize(paths.dataDir);
        await assertFreeSpace(dirname(paths.dataDir), requiredBytes);
        await cp(paths.dataDir, join(paths.stagingRoot, 'previous-data-dir'), {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          filter: shouldCopyCheckpointEntry,
        });
      }
    }
    assertFence();
    const activeFingerprint = await fingerprintGeneration(paths.dataDir, sourceAbsent);
    const copiedFingerprint = await fingerprintGeneration(
      join(paths.stagingRoot, 'previous-data-dir'),
      sourceAbsent,
    );
    if (activeFingerprint !== copiedFingerprint) throw new Error('Checkpoint fingerprint mismatch');
    await syncTree(join(paths.stagingRoot, 'previous-data-dir'), sourceAbsent);
    const manifest: GenerationManifest = {
      schemaVersion: 1,
      sourceRelease: options.sourceRelease ?? SOURCE_RELEASE,
      targetRelease: options.targetRelease ?? TARGET_RELEASE,
      activeFingerprint,
      sourceAbsent,
      completed: true,
    };
    await writeNewJson(join(paths.stagingRoot, 'manifest.json'), manifest);
    await syncDirectoryBestEffort(paths.stagingRoot);
    assertFence();
    await options.faults?.beforePublish?.();
    await rename(paths.stagingRoot, paths.root);
    await syncDirectoryBestEffort(dirname(paths.root));
    return { created: true, sourceAbsent };
  } catch (error) {
    await removeStagingRoot(paths);
    throw error;
  }
}

function checkpointError(error: unknown): Error {
  return errorCode(error) === CHECKPOINT_ERROR_CODE
    ? (error as Error)
    : codedError(CHECKPOINT_ERROR_CODE, 'Rootless V2 checkpoint failed', error);
}

/**
 * Switches whole data-directory generations after the product has stopped and
 * verified every Electron/Utility/CLI/TUI owner. The caller's verification
 * must keep the existing launch-owner fence held until this function returns.
 */
export async function switchRootlessV2Generation(options: {
  readonly dataDir: string;
  readonly direction: SwapDirection;
  readonly verifyOwnersStopped: () => void | Promise<void>;
  readonly sourceRelease?: string;
  readonly targetRelease?: string;
  /** @internal Deterministic rename crash seams. */
  readonly faults?: RootlessV2SwapFaultHooks;
}): Promise<RootlessV2GenerationSwapResult> {
  try {
    await options.verifyOwnersStopped();
    const paths = generationPaths(options.dataDir);
    return await withGenerationOperationLock(paths, async (assertFence) => {
      await assertRuntimeOwnersStopped(paths.dataDir);
      let manifest = await readAndValidateManifest(paths, options);
      const pendingJournal = await readJournal(paths.journal);
      if (
        pendingJournal?.operation === 'rollback' &&
        (await hasPreviousGenerationActiveLayout(paths))
      ) {
        manifest = await publishPreviousFingerprint(paths, manifest);
      }
      const recovered = await recoverSwapJournal(paths, manifest, assertFence);
      manifest = await readAndValidateManifest(paths, options);
      if (await hasPreviousGenerationActiveLayout(paths)) {
        manifest = await publishPreviousFingerprint(paths, manifest);
      }
      const activeGeneration = await detectStableGeneration(paths, manifest);
      const requestedGeneration = options.direction === 'rollback' ? 'previous' : 'upgraded';
      if (activeGeneration === requestedGeneration) {
        return { changed: recovered, activeGeneration };
      }

      if (options.direction === 'rollback') {
        await publishUpgradedFingerprint(paths, manifest);
      }
      const currentManifest = await readAndValidateManifest(paths, options);
      await writeJournal(paths, { operation: options.direction, stage: 'prepared' });
      await executeSwap({
        paths,
        manifest: currentManifest,
        direction: options.direction,
        assertFence,
        faults: options.faults,
      });
      return { changed: true, activeGeneration: requestedGeneration };
    });
  } catch (error) {
    if (isOwnersActiveError(error)) throw error;
    if (errorCode(error) === SWAP_ERROR_CODE) throw error;
    throw codedError(SWAP_ERROR_CODE, 'Rootless V2 generation swap failed', error);
  }
}

async function executeSwap(input: {
  readonly paths: GenerationPaths;
  readonly manifest: GenerationManifest;
  readonly direction: SwapDirection;
  readonly assertFence: () => void;
  readonly faults?: RootlessV2SwapFaultHooks;
}): Promise<void> {
  const { paths, manifest, direction, assertFence } = input;
  const faults = input.faults ?? {};
  const previousPresent = currentPreviousState(manifest).present;
  if (direction === 'rollback') {
    await rename(paths.dataDir, paths.upgraded);
    await syncSwapParents(paths);
    assertFence();
    await faults.afterFirstRename?.();
    await writeJournal(paths, { operation: direction, stage: 'active-saved' });
    if (previousPresent) {
      await rename(paths.previous, paths.dataDir);
      await syncSwapParents(paths);
      assertFence();
      await faults.afterSecondRename?.();
    }
  } else {
    if (previousPresent) {
      await rename(paths.dataDir, paths.previous);
      await syncSwapParents(paths);
      assertFence();
      await faults.afterFirstRename?.();
      await writeJournal(paths, { operation: direction, stage: 'active-saved' });
    }
    await rename(paths.upgraded, paths.dataDir);
    await syncSwapParents(paths);
    assertFence();
    await faults.afterSecondRename?.();
  }
  await writeJournal(paths, { operation: direction, stage: 'target-activated' });
  await verifyActiveGeneration(paths, manifest, direction === 'rollback' ? 'previous' : 'upgraded');
  await rm(paths.journal, { force: true });
  await syncDirectoryBestEffort(paths.root);
}

async function recoverSwapJournal(
  paths: GenerationPaths,
  manifest: GenerationManifest,
  assertFence: () => void,
): Promise<boolean> {
  const journal = await readJournal(paths.journal);
  if (!journal) return false;
  if (journal.operation === 'rollback') {
    await recoverRollback(paths, manifest, assertFence);
  } else {
    await recoverReupgrade(paths, manifest, assertFence);
  }
  await rm(paths.journal, { force: true });
  await syncDirectoryBestEffort(paths.root);
  return true;
}

async function recoverRollback(
  paths: GenerationPaths,
  manifest: GenerationManifest,
  assertFence: () => void,
): Promise<void> {
  const previousPresent = currentPreviousState(manifest).present;
  if (!(await pathExists(paths.upgraded))) {
    if (!(await pathExists(paths.dataDir))) throw new Error('Rollback source is missing');
    await rename(paths.dataDir, paths.upgraded);
    await syncSwapParents(paths);
    assertFence();
  }
  if (previousPresent && !(await pathExists(paths.dataDir))) {
    if (!(await pathExists(paths.previous))) throw new Error('Previous generation is missing');
    await rename(paths.previous, paths.dataDir);
    await syncSwapParents(paths);
    assertFence();
  }
  await verifyActiveGeneration(paths, manifest, 'previous');
}

async function recoverReupgrade(
  paths: GenerationPaths,
  manifest: GenerationManifest,
  assertFence: () => void,
): Promise<void> {
  const previousPresent = currentPreviousState(manifest).present;
  if (previousPresent && !(await pathExists(paths.previous))) {
    if (!(await pathExists(paths.dataDir)))
      throw new Error('Previous active generation is missing');
    await rename(paths.dataDir, paths.previous);
    await syncSwapParents(paths);
    assertFence();
  }
  if (!(await pathExists(paths.dataDir))) {
    if (!(await pathExists(paths.upgraded))) throw new Error('Upgraded generation is missing');
    await rename(paths.upgraded, paths.dataDir);
    await syncSwapParents(paths);
    assertFence();
  }
  await verifyActiveGeneration(paths, manifest, 'upgraded');
}

async function detectStableGeneration(
  paths: GenerationPaths,
  manifest: GenerationManifest,
): Promise<Generation> {
  const [active, previous, upgraded] = await Promise.all([
    pathExists(paths.dataDir),
    pathExists(paths.previous),
    pathExists(paths.upgraded),
  ]);
  const previousState = currentPreviousState(manifest);
  if (upgraded && !previous && active === previousState.present) {
    await verifyActiveGeneration(paths, manifest, 'previous');
    return 'previous';
  }
  const expectedPrevious = previousState.present ? previous : !previous;
  if (active && !upgraded && expectedPrevious) {
    await verifyPreviousCheckpoint(paths, manifest);
    return 'upgraded';
  }
  throw new Error('Generation layout is inconsistent');
}

async function hasPreviousGenerationActiveLayout(paths: GenerationPaths): Promise<boolean> {
  const [previous, upgraded] = await Promise.all([
    pathExists(paths.previous),
    pathExists(paths.upgraded),
  ]);
  return upgraded && !previous;
}

async function verifyActiveGeneration(
  paths: GenerationPaths,
  manifest: GenerationManifest,
  generation: Generation,
): Promise<void> {
  const previousState = currentPreviousState(manifest);
  const sourceAbsent = generation === 'previous' && !previousState.present;
  const expected =
    generation === 'previous' ? previousState.fingerprint : manifest.upgradedFingerprint;
  if (!expected) throw new Error('Upgraded generation fingerprint is missing');
  const actual = await fingerprintGeneration(paths.dataDir, sourceAbsent);
  if (actual !== expected) throw new Error('Active generation fingerprint mismatch');
}

async function verifyPreviousCheckpoint(
  paths: GenerationPaths,
  manifest: GenerationManifest,
): Promise<void> {
  const previousState = currentPreviousState(manifest);
  const actual = await fingerprintGeneration(paths.previous, !previousState.present);
  if (actual !== previousState.fingerprint) throw new Error('Previous checkpoint is inconsistent');
}

function currentPreviousState(manifest: GenerationManifest): {
  readonly present: boolean;
  readonly fingerprint: string;
} {
  return {
    present: manifest.previousPresent ?? !manifest.sourceAbsent,
    fingerprint: manifest.previousFingerprint ?? manifest.activeFingerprint,
  };
}

async function publishPreviousFingerprint(
  paths: GenerationPaths,
  manifest: GenerationManifest,
): Promise<GenerationManifest> {
  const previousPresent = await pathExists(paths.dataDir);
  const previousFingerprint = await fingerprintGeneration(paths.dataDir, !previousPresent);
  if (
    manifest.previousPresent === previousPresent &&
    manifest.previousFingerprint === previousFingerprint
  ) {
    return manifest;
  }
  const next = { ...manifest, previousPresent, previousFingerprint };
  await writeJsonAtomically(paths.manifest, next);
  return next;
}

async function publishUpgradedFingerprint(
  paths: GenerationPaths,
  manifest: GenerationManifest,
): Promise<void> {
  if (!(await pathExists(paths.dataDir))) throw new Error('Active upgraded generation is missing');
  const upgradedFingerprint = await fingerprintGeneration(paths.dataDir, false);
  if (manifest.upgradedFingerprint !== upgradedFingerprint) {
    await writeJsonAtomically(paths.manifest, { ...manifest, upgradedFingerprint });
  }
}

async function removeStagingRoot(paths: GenerationPaths): Promise<void> {
  await rm(paths.stagingRoot, { recursive: true, force: true });
}
