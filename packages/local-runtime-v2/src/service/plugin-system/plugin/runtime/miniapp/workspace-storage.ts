import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceMiniAppInitializationResult } from '../../../contracts.js';
import { PluginSystemError } from '../../../errors.js';
import { runAllFinally } from '../../../plugin-system-helpers.js';
import { canonicalizePluginRoot, readPluginJsonObject } from '../../package/filesystem.js';
import { readMiniAppMcode } from '../../package/miniapp/reader.js';
import {
  computePluginDirectoryDigest,
  validatePluginPortablePath,
} from '../../package/package-contract.js';
import { isMiniAppRuntimePayloadExcludedPath } from '../../package/miniapp/path.js';
import { readLocalMiniMaxPluginPackage } from '../../package/package-readers.js';
import type { ScannedLocalPluginPackage } from '../../package/types.js';
import { writeWorkspaceMiniAppScaffold } from './workspace-scaffold.js';

const WORKSPACE_INIT_MARKER = '.mavis-miniapp-init';
const WORKSPACE_PACKAGE_DIRECTORIES = ['miniapps', 'liveboards'] as const;

type WorkspacePackageDirectory = (typeof WORKSPACE_PACKAGE_DIRECTORIES)[number];

interface ExistingWorkspacePackageLocation {
  readonly packagesRoot: string;
  readonly target: string;
  readonly packagePath: `miniapps/${string}` | `liveboards/${string}`;
}

interface StagedLocalPluginRoot {
  readonly restore: () => Promise<void>;
  readonly discard: () => Promise<void>;
}

interface AcceptedLocalPluginRoot {
  readonly rootPath: string;
  readonly restore: () => Promise<void>;
}

interface WorkspaceMiniAppLocalRoots {
  readonly stageAccepted: (canonicalRoot: string) => Promise<StagedLocalPluginRoot>;
  readonly acceptImported: (
    stagingRoot: string,
    pluginName: string,
  ) => Promise<AcceptedLocalPluginRoot>;
}

export interface StagedWorkspaceMiniAppCandidate {
  readonly contentDigest: string;
  readonly install: () => Promise<void>;
  readonly rollback: () => Promise<void>;
  readonly finalize: () => Promise<void>;
}

/** Owns MiniApp source staging, workspace initialization, and install rollback. */
export class WorkspaceMiniAppStorage {
  constructor(
    private readonly dataDir: string,
    private readonly localRoots: WorkspaceMiniAppLocalRoots,
  ) {}

  async readPackageRoot(packageRoot: string): Promise<ScannedLocalPluginPackage> {
    return readLocalMiniMaxPluginPackage(packageRoot, { rejectHardlinks: true });
  }

  async materializeRuntimePackage(input: {
    readonly sourceRoot: string;
    readonly targetRoot: string;
  }): Promise<void> {
    await copyRuntimePayload(input.sourceRoot, input.targetRoot);
  }

  async initialize(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceMiniAppInitializationResult> {
    try {
      return await initializeWorkspacePackage(input);
    } catch (error) {
      if (input.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      throw workspaceCandidateError(error);
    }
  }

  /**
   * Copies the selected complete package into Host-owned stable staging.
   * Installation stays provisional until the shared Plugin publication finalizes.
   */
  async stageCandidate(input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly sourcePath?: string;
    readonly signal?: AbortSignal;
  }): Promise<StagedWorkspaceMiniAppCandidate> {
    try {
      throwIfAborted(input.signal);
      const source =
        input.sourcePath === undefined
          ? await resolveWorkspaceCandidate(input)
          : await resolveSuppliedCandidate(this.dataDir, input);
      const staged = await stageStableDirectoryCandidate(this.dataDir, input, source);
      return this.candidateTransaction(staged.stagingContainer, staged.stagingRoot, staged.package);
    } catch (error) {
      throwIfAborted(input.signal);
      throw workspaceCandidateError(error);
    }
  }

  private candidateTransaction(
    stagingContainer: string,
    stagingRoot: string,
    stagedPackage: ScannedLocalPluginPackage,
  ): StagedWorkspaceMiniAppCandidate {
    let prior: StagedLocalPluginRoot | undefined;
    let accepted: AcceptedLocalPluginRoot | undefined;
    let installed = false;
    let settlement: Promise<void> | undefined;
    const cleanupStaging = () => rm(stagingContainer, { recursive: true, force: true });
    const settle = (kind: 'rollback' | 'finalize'): Promise<void> => {
      settlement ??= runAllFinally(
        kind === 'rollback'
          ? [() => accepted?.restore(), () => prior?.restore(), () => cleanupStaging()]
          : [() => prior?.discard(), () => cleanupStaging()],
      );
      return settlement;
    };
    return {
      contentDigest: stagedPackage.contentDigest,
      install: async () => {
        if (settlement) {
          throw new PluginSystemError('WORKSPACE_INSTALL_FAILED', 'workspace candidate is closed');
        }
        if (installed) return;
        const target = path.join(this.dataDir, 'plugins', stagedPackage.plugin.name);
        try {
          prior = await stageExistingWorkspaceTarget(target, stagedPackage.plugin.name, (root) =>
            this.localRoots.stageAccepted(root),
          );
          accepted = await this.localRoots.acceptImported(stagingRoot, stagedPackage.plugin.name);
          await assertInstalledWorkspaceCandidate(accepted.rootPath, stagedPackage);
          installed = true;
        } catch (error) {
          await runAllFinally([() => accepted?.restore(), () => prior?.restore()]);
          throw workspaceInstallError(error);
        }
      },
      rollback: () => settle('rollback'),
      finalize: () => settle('finalize'),
    };
  }
}

async function initializeWorkspacePackage(input: {
  readonly workspaceRoot: string;
  readonly pluginId: string;
  readonly signal?: AbortSignal;
}): Promise<WorkspaceMiniAppInitializationResult> {
  assertPortablePluginId(input.pluginId);
  throwIfAborted(input.signal);
  const workspaceRoot = await realpath(input.workspaceRoot);
  throwIfAborted(input.signal);

  const existing = await resolveExistingWorkspacePackageLocation(workspaceRoot, input.pluginId);
  if (existing) {
    await assertExistingWorkspacePackage(existing.target, existing.packagesRoot, input.pluginId);
    throwIfAborted(input.signal);
    return {
      pluginId: input.pluginId,
      mode: 'update',
      packagePath: existing.packagePath,
    };
  }

  const miniappsRoot = await ensureWorkspaceMiniAppsRoot(workspaceRoot);
  const target = path.join(miniappsRoot, input.pluginId);
  const packagePath = `miniapps/${input.pluginId}` as const;
  const stagingRoot = await mkdtemp(path.join(miniappsRoot, `.init-${input.pluginId}-`));
  let committed = false;
  try {
    await writeWorkspaceMiniAppScaffold(stagingRoot, input.pluginId);
    const staged = await readLocalMiniMaxPluginPackage(await realpath(stagingRoot), {
      rejectHardlinks: true,
      requireMiniApp: true,
    });
    if (staged.plugin.name !== input.pluginId || !staged.plugin.miniapp) {
      throw new Error('workspace MiniApp scaffold identity mismatch');
    }
    throwIfAborted(input.signal);
    await commitNewWorkspacePackage(stagingRoot, target);
    committed = true;
    return { pluginId: input.pluginId, mode: 'create', packagePath };
  } finally {
    if (!committed) await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function stageExistingWorkspaceTarget(
  target: string,
  pluginName: string,
  stage: (canonicalRoot: string) => Promise<StagedLocalPluginRoot>,
): Promise<StagedLocalPluginRoot | undefined> {
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw workspaceTargetConflict();
    }
    const canonicalRoot = await realpath(target);
    await assertWorkspaceTargetIdentity(canonicalRoot, pluginName);
    return stage(canonicalRoot);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return undefined;
  }
}

async function assertWorkspaceTargetIdentity(
  canonicalRoot: string,
  pluginName: string,
): Promise<void> {
  try {
    const installed = await readLocalMiniMaxPluginPackage(canonicalRoot, {
      rejectHardlinks: true,
    });
    if (
      installed.plugin.rootPath === canonicalRoot &&
      installed.plugin.name === pluginName &&
      installed.plugin.miniapp
    ) {
      return;
    }
  } catch {
    // An unreadable or invalid target cannot prove the same canonical MiniApp identity.
  }
  throw workspaceTargetConflict();
}

function workspaceTargetConflict(): PluginSystemError {
  return new PluginSystemError('PLUGIN_ALREADY_EXISTS', 'local Plugin directory already exists');
}

async function assertInstalledWorkspaceCandidate(
  rootPath: string,
  expected: ScannedLocalPluginPackage,
): Promise<void> {
  const observed = await readLocalMiniMaxPluginPackage(rootPath, { rejectHardlinks: true });
  if (
    observed.plugin.name === expected.plugin.name &&
    observed.plugin.miniapp &&
    observed.contentDigest === expected.contentDigest
  ) {
    return;
  }
  throw new PluginSystemError(
    'WORKSPACE_INSTALL_FAILED',
    'installed workspace candidate identity changed',
  );
}

function assertPortablePluginId(pluginId: string): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u.test(pluginId)) {
    throw new PluginSystemError(
      'WORKSPACE_CANDIDATE_INVALID',
      'workspace MiniApp candidate is invalid',
    );
  }
  validatePluginPortablePath(pluginId);
}

async function resolveExistingWorkspacePackageLocation(
  workspaceRoot: string,
  pluginId: string,
): Promise<ExistingWorkspacePackageLocation | undefined> {
  const rootStat = await lstat(workspaceRoot);
  if (!rootStat.isDirectory()) throw new Error('workspace root is not a directory');

  const existing: ExistingWorkspacePackageLocation[] = [];
  for (const directory of WORKSPACE_PACKAGE_DIRECTORIES) {
    const packagesRoot = await resolveExistingWorkspacePackagesRoot(workspaceRoot, directory);
    if (!packagesRoot) continue;
    const target = path.join(packagesRoot, pluginId);
    if (!(await pathExists(target))) continue;
    existing.push({
      packagesRoot,
      target,
      packagePath: `${directory}/${pluginId}` as ExistingWorkspacePackageLocation['packagePath'],
    });
  }
  if (existing.length > 1) {
    throw new PluginSystemError(
      'WORKSPACE_CANDIDATE_INVALID',
      'workspace Mini App candidate exists in both current and legacy directories',
      { reasonCode: 'WORKSPACE_CANDIDATE_INVALID' },
    );
  }
  return existing[0];
}

async function ensureWorkspaceMiniAppsRoot(workspaceRoot: string): Promise<string> {
  const miniappsRoot = path.join(workspaceRoot, 'miniapps');
  try {
    await mkdir(miniappsRoot);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const canonicalRoot = await resolveExistingWorkspacePackagesRoot(workspaceRoot, 'miniapps');
  if (!canonicalRoot) throw new Error('workspace Mini App directory is unavailable');
  return canonicalRoot;
}

async function resolveExistingWorkspacePackagesRoot(
  workspaceRoot: string,
  directory: WorkspacePackageDirectory,
): Promise<string | undefined> {
  const requestedRoot = path.join(workspaceRoot, directory);
  let stat;
  try {
    stat = await lstat(requestedRoot);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('unsafe workspace MiniApp directory');
  }
  const canonicalRoot = await realpath(requestedRoot);
  if (path.dirname(canonicalRoot) !== workspaceRoot) {
    throw new Error('workspace MiniApp directory escaped workspace');
  }
  return canonicalRoot;
}

async function assertExistingWorkspacePackage(
  target: string,
  packagesRoot: string,
  pluginId: string,
): Promise<void> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('unsafe workspace MiniApp package root');
  }
  const canonicalTarget = await realpath(target);
  if (path.dirname(canonicalTarget) !== packagesRoot) {
    throw new Error('workspace MiniApp package escaped workspace');
  }
  await assertWorkspaceInitCommitted(canonicalTarget);
  await computePluginDirectoryDigest(canonicalTarget, { rejectHardlinks: true });
  const root = await canonicalizePluginRoot(canonicalTarget, { rejectSymlink: true });
  const manifest = await readPluginJsonObject(root, '.minimax-plugin/plugin.json', {
    portable: true,
  });
  const packageJson = await readPluginJsonObject(root, 'package.json', { portable: true });
  if (manifest.value.name !== pluginId) {
    throw new Error('workspace MiniApp package identity mismatch');
  }
  try {
    readMiniAppMcode(packageJson.value.mcode);
  } catch {
    // Update identity historically exposes one stable workspace reason rather
    // than the package reader's detailed authoring-schema diagnostic.
    throw new Error('workspace MiniApp package identity mismatch');
  }
}

/** @internal Direct-module regression seam for the no-replace directory commit. */
export async function commitNewWorkspacePackage(
  stagingRoot: string,
  target: string,
  operations: {
    readonly token?: string;
    readonly afterReservation?: (target: string) => Promise<void>;
    readonly removeStaging?: (stagingRoot: string) => Promise<void>;
  } = {},
): Promise<void> {
  const token = operations.token ?? randomUUID();
  const markerPath = path.join(target, WORKSPACE_INIT_MARKER);
  let targetIdentity: WorkspaceDirectoryIdentity | undefined;
  try {
    await mkdir(target);
    targetIdentity = await readWorkspaceDirectoryIdentity(target);
    await writeFile(markerPath, token, { flag: 'wx', mode: 0o600 });
    await operations.afterReservation?.(target);
    for (const entry of (await readdir(stagingRoot)).sort()) {
      await cp(path.join(stagingRoot, entry), path.join(target, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    if (!(await ownsWorkspaceInitTarget(target, markerPath, token, targetIdentity))) {
      throw new Error('workspace MiniApp initialization ownership changed');
    }
    // Removing the private marker is the commit point. Before this succeeds a
    // reader must treat the visible target as an incomplete initialization.
    await unlink(markerPath);
  } catch (error) {
    if (targetIdentity) {
      await quarantineOwnedWorkspaceInitTarget(target, markerPath, token, targetIdentity);
    }
    if (isAlreadyExists(error)) {
      throw new PluginSystemError(
        'WORKSPACE_CANDIDATE_INVALID',
        'workspace MiniApp candidate is invalid',
        { reasonCode: 'WORKSPACE_CANDIDATE_INVALID' },
      );
    }
    throw error;
  }
  try {
    await (operations.removeStaging ?? removeWorkspaceInitStaging)(stagingRoot);
  } catch {
    // The target is committed once its marker is removed. Staging cleanup is
    // best-effort and must not rewrite a successful initialization result.
  }
}

async function assertWorkspaceInitCommitted(target: string): Promise<void> {
  try {
    await lstat(path.join(target, WORKSPACE_INIT_MARKER));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new PluginSystemError(
    'WORKSPACE_CANDIDATE_INVALID',
    'workspace MiniApp candidate is invalid',
    { reasonCode: 'WORKSPACE_CANDIDATE_INVALID' },
  );
}

interface WorkspaceDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function readWorkspaceDirectoryIdentity(target: string): Promise<WorkspaceDirectoryIdentity> {
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('workspace MiniApp initialization target is unsafe');
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function ownsWorkspaceInitTarget(
  target: string,
  markerPath: string,
  token: string,
  expected: WorkspaceDirectoryIdentity,
): Promise<boolean> {
  try {
    const rootBefore = await lstat(target);
    const markerBefore = await lstat(markerPath);
    if (
      rootBefore.isSymbolicLink() ||
      !rootBefore.isDirectory() ||
      !sameWorkspaceIdentity(rootBefore, expected) ||
      markerBefore.isSymbolicLink() ||
      !markerBefore.isFile() ||
      markerBefore.nlink !== 1
    ) {
      return false;
    }
    const observedToken = await readFile(markerPath, 'utf8');
    const markerAfter = await lstat(markerPath);
    const rootAfter = await lstat(target);
    return (
      observedToken === token &&
      sameWorkspaceIdentity(rootAfter, expected) &&
      sameWorkspaceIdentity(markerAfter, markerBefore)
    );
  } catch {
    return false;
  }
}

function sameWorkspaceIdentity(
  observed: WorkspaceDirectoryIdentity,
  expected: WorkspaceDirectoryIdentity,
): boolean {
  return observed.dev === expected.dev && observed.ino === expected.ino;
}

async function quarantineOwnedWorkspaceInitTarget(
  target: string,
  markerPath: string,
  token: string,
  expected: WorkspaceDirectoryIdentity,
): Promise<void> {
  if (!(await ownsWorkspaceInitTarget(target, markerPath, token, expected))) return;
  const quarantine = path.join(path.dirname(target), `.failed-init-${token}`);
  if (await pathExists(quarantine)) return;
  try {
    await rename(target, quarantine);
  } catch {
    // Ownership or filesystem state changed; leave the target untouched.
  }
}

async function removeWorkspaceInitStaging(stagingRoot: string): Promise<void> {
  await rm(stagingRoot, { recursive: true });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Mini App action aborted');
  error.name = 'AbortError';
  throw error;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'EEXIST' ||
      (error as { code?: unknown }).code === 'ERR_FS_CP_EEXIST')
  );
}

async function resolveWorkspaceCandidate(input: {
  readonly workspaceRoot: string;
  readonly pluginId: string;
}): Promise<{ readonly source: string; readonly package: ScannedLocalPluginPackage }> {
  assertPortablePluginId(input.pluginId);
  const workspaceRoot = await realpath(input.workspaceRoot);
  const location = await resolveExistingWorkspacePackageLocation(workspaceRoot, input.pluginId);
  if (!location) {
    throw new PluginSystemError(
      'WORKSPACE_CANDIDATE_INVALID',
      'workspace MiniApp candidate is missing',
      { reasonCode: 'MINIAPP_WORKSPACE_CANDIDATE_MISSING' },
    );
  }
  const sourceStat = await lstat(location.target);
  const source = await realpath(location.target);
  if (
    sourceStat.isSymbolicLink() ||
    !sourceStat.isDirectory() ||
    path.dirname(source) !== location.packagesRoot
  ) {
    throw new Error('unsafe workspace MiniApp candidate root');
  }
  const packageRead = await readLocalMiniMaxPluginPackage(source, {
    rejectHardlinks: true,
    requireMiniApp: true,
  });
  if (packageRead.plugin.name !== input.pluginId) {
    throw new Error('workspace MiniApp candidate identity mismatch');
  }
  if (!packageRead.plugin.miniapp) {
    throw new PluginSystemError(
      'WORKSPACE_CANDIDATE_INVALID',
      'workspace MiniApp candidate is invalid',
      { reasonCode: 'MINIAPP_MCODE_SCHEMA_INVALID' },
    );
  }
  return { source, package: packageRead };
}

async function stageStableDirectoryCandidate(
  dataDir: string,
  input: {
    readonly pluginId: string;
    readonly sourcePath?: string;
    readonly signal?: AbortSignal;
  },
  source: { readonly source: string; readonly package: ScannedLocalPluginPackage },
): Promise<{
  readonly stagingContainer: string;
  readonly stagingRoot: string;
  readonly package: ScannedLocalPluginPackage;
}> {
  const importRoot = path.join(dataDir, 'v2', 'plugin-import');
  if (isWithin(source.source, await resolveFuturePath(importRoot))) {
    throw new Error('MiniApp source contains the Host staging directory');
  }
  await mkdir(importRoot, { recursive: true });
  const stagingContainer = await mkdtemp(path.join(importRoot, 'candidate-'));
  const stagingRoot = path.join(stagingContainer, 'package');
  try {
    await copyRuntimePayload(source.source, stagingRoot);
    throwIfAborted(input.signal);
    const stagedPackage = await readLocalMiniMaxPluginPackage(await realpath(stagingRoot), {
      rejectHardlinks: true,
      requireMiniApp: true,
    });
    const sourceMiniApp = source.package.plugin.miniapp;
    if (
      stagedPackage.plugin.name !== input.pluginId ||
      !sourceMiniApp ||
      !stagedPackage.plugin.miniapp ||
      stagedPackage.plugin.miniapp.contentDigest !== sourceMiniApp.contentDigest
    ) {
      const error = new Error('workspace MiniApp candidate changed while staging');
      throw input.sourcePath === undefined ? error : suppliedCandidateError(error);
    }
    return { stagingContainer, stagingRoot, package: stagedPackage };
  } catch (error) {
    await rm(stagingContainer, { recursive: true, force: true });
    throw error;
  }
}

async function resolveSuppliedCandidate(
  dataDir: string,
  input: {
    readonly workspaceRoot: string;
    readonly pluginId: string;
    readonly sourcePath?: string;
  },
): Promise<{ readonly source: string; readonly package: ScannedLocalPluginPackage }> {
  assertPortablePluginId(input.pluginId);
  let source: string;
  try {
    if (!input.sourcePath || input.sourcePath.length > 4096 || input.sourcePath.includes('\0')) {
      throw new Error('invalid MiniApp source path');
    }
    const sourcePath = path.resolve(input.workspaceRoot, input.sourcePath);
    if (!(await lstat(sourcePath)).isDirectory()) {
      throw new Error('MiniApp source must be a directory');
    }
    source = await realpath(sourcePath);
  } catch (error) {
    throw suppliedCandidateError(error);
  }
  await assertSourceOutsideInstallation(source, path.join(dataDir, 'plugins', input.pluginId));
  try {
    const sourcePackage = await readLocalMiniMaxPluginPackage(source, {
      rejectHardlinks: true,
      requireMiniApp: true,
    });
    if (sourcePackage.plugin.name !== input.pluginId) {
      throw new PluginSystemError(
        'WORKSPACE_CANDIDATE_INVALID',
        'MiniApp source identity mismatch',
        {
          reasonCode: 'MINIAPP_SOURCE_IDENTITY_MISMATCH',
        },
      );
    }
    return { source, package: sourcePackage };
  } catch (error) {
    throw suppliedCandidateError(error);
  }
}

async function resolveFuturePath(destination: string): Promise<string> {
  let ancestor = path.resolve(destination);
  const segments: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(ancestor), ...segments);
    } catch (error) {
      if (!isMissing(error) || path.dirname(ancestor) === ancestor) throw error;
      segments.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

async function assertSourceOutsideInstallation(source: string, destination: string): Promise<void> {
  const installedRoot = await resolveFuturePath(destination);
  if (isWithin(installedRoot, source) || isWithin(source, installedRoot)) {
    throw new PluginSystemError(
      'WORKSPACE_CANDIDATE_INVALID',
      'MiniApp source overlaps installation',
      {
        reasonCode: 'MINIAPP_SOURCE_OVERLAP',
      },
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function suppliedCandidateError(error: unknown): PluginSystemError {
  if (error instanceof PluginSystemError && error.code === 'WORKSPACE_CANDIDATE_INVALID') {
    return error;
  }
  const unavailable = ['ENOENT', 'EACCES', 'EPERM'].includes(codedErrorReason(error) ?? '');
  return new PluginSystemError(
    'WORKSPACE_CANDIDATE_INVALID',
    'MiniApp source could not be staged',
    {
      reasonCode: unavailable ? 'MINIAPP_SOURCE_UNAVAILABLE' : 'MINIAPP_SOURCE_INVALID',
    },
  );
}

async function copyRuntimePayload(sourceRoot: string, targetRoot: string): Promise<void> {
  await cp(sourceRoot, targetRoot, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    filter: (sourcePath) => {
      const relativePath = path.relative(sourceRoot, sourcePath);
      return (
        relativePath === '' ||
        !isMiniAppRuntimePayloadExcludedPath(relativePath.split(path.sep).join('/'))
      );
    },
    force: false,
    verbatimSymlinks: true,
  });
}

function workspaceCandidateError(error: unknown): PluginSystemError {
  if (
    error instanceof PluginSystemError &&
    error.code === 'WORKSPACE_CANDIDATE_INVALID' &&
    error.reasonCode
  ) {
    return error;
  }
  return new PluginSystemError(
    'WORKSPACE_CANDIDATE_INVALID',
    'workspace MiniApp candidate is invalid',
    { reasonCode: workspaceCandidateReasonCode(error) },
  );
}

function workspaceInstallError(error: unknown): PluginSystemError {
  if (
    error instanceof PluginSystemError &&
    (error.code === 'PLUGIN_ALREADY_EXISTS' ||
      (error.code === 'WORKSPACE_INSTALL_FAILED' && error.reasonCode))
  ) {
    return error;
  }
  return new PluginSystemError(
    'WORKSPACE_INSTALL_FAILED',
    'workspace MiniApp candidate installation failed',
    { reasonCode: codedErrorReason(error) ?? 'WORKSPACE_INSTALL_FAILED' },
  );
}

function workspaceCandidateReasonCode(error: unknown): string {
  const code = codedErrorReason(error);
  return code?.startsWith('MINIAPP_') || code?.startsWith('PLUGIN_')
    ? code
    : 'WORKSPACE_CANDIDATE_INVALID';
}

function codedErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const reasonCode = (error as { readonly reasonCode?: unknown }).reasonCode;
  if (typeof reasonCode === 'string') return reasonCode;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
