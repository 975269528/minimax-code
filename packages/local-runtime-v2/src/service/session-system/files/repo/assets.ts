import { collectMessageAssetItems } from '@mavis/shared/asset-markup';
import { mkdir, copyFile, lstat, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { and, asc, desc, eq, gt, inArray, lt, notExists, or } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import {
  messageRows,
  newerSessionAssets,
  sessionAssetIndexState,
  sessionAssets,
} from '../../../../infra/db/schema/messages.js';
import type { NormalizedDisplayMessage } from '../../messages/repo/contract.js';
import { decodeDisplayMessage, type MessageStorageRow } from '../../messages/repo/codec.js';
import type {
  SessionAssetPage,
  SessionAssetCopyInput,
  SessionAssetPageOptions,
  SessionAssetRepository,
  SessionAssetRepositoryOptions,
  SessionAssetIndexState,
  SessionAssetRecord,
} from './contract.js';
import { decodeAssetCursor, encodeAssetCursor } from './cursor.js';
import {
  markAssetIndexCurrent,
  reconcileForkDisplayAssets,
  removeForkDisplayAssets,
  type ForkAssetProjection,
} from './fork-copy-projection.js';

export function replaceMessageAssets(
  db: AppDb,
  sessionId: string,
  message: NormalizedDisplayMessage,
  nowMs: number,
): void {
  db.delete(sessionAssets)
    .where(and(eq(sessionAssets.sessionId, sessionId), eq(sessionAssets.messageId, message.msgId)))
    .run();
  if (message.role !== 'assistant') return;
  const content = messageContent(message.dataJson);
  const wrapperKeys = new Set(
    collectMessageAssetItems(content, { includeStandaloneMedia: false }).map(assetKey),
  );
  collectMessageAssetItems(content).forEach((asset, assetIndex) => {
    const key = assetKey(asset);
    if (!key) return;
    db.insert(sessionAssets)
      .values({
        sessionId,
        messageId: message.msgId,
        role: message.role,
        messageCreatedAtMs: message.createdAtMs,
        assetIndex,
        assetKey: key,
        sourceTag: wrapperKeys.has(key) ? 'deliver-assets' : 'media',
        path: asset.path,
        name: asset.name ?? null,
        assetType: asset.type ?? null,
        artifactId: asset.artifactId ?? null,
        driveNodeId: asset.driveNodeId ?? null,
        dataJson: JSON.stringify(asset),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      })
      .run();
  });
}

export function createSessionAssetRepository(
  options: SessionAssetRepositoryOptions,
): SessionAssetRepository {
  return new DrizzleSessionAssetRepository(options);
}

class DrizzleSessionAssetRepository implements SessionAssetRepository {
  constructor(private readonly options: SessionAssetRepositoryOptions) {}

  async getIndexState(sessionId: string): Promise<SessionAssetIndexState | undefined> {
    const row = this.options.db
      .select()
      .from(sessionAssetIndexState)
      .where(eq(sessionAssetIndexState.sessionId, sessionId))
      .get();
    return row ?? undefined;
  }

  async rebuild(sessionId: string, nowMs: number): Promise<SessionAssetIndexState> {
    return this.options.db.transaction((tx) => {
      tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
      const rows = tx
        .select()
        .from(messageRows)
        .where(eq(messageRows.sessionId, sessionId))
        .orderBy(asc(messageRows.id))
        .all();
      for (const row of rows) {
        const message = normalizedFromRow(row);
        replaceMessageAssets(tx, sessionId, message, nowMs);
      }
      const state = {
        sessionId,
        indexVersion: 1,
        indexedThroughMessageRowId: rows.at(-1)?.id ?? 0,
        indexedAtMs: nowMs,
        status: 'ready',
        errorJson: null,
      };
      tx.insert(sessionAssetIndexState)
        .values(state)
        .onConflictDoUpdate({ target: sessionAssetIndexState.sessionId, set: state })
        .run();
      return state;
    });
  }

  async listPage(options: SessionAssetPageOptions): Promise<SessionAssetPage> {
    const limit = normalizeLimit(options.limit);
    const cursor = decodeAssetCursor(options.cursor, options.sessionId);
    const all = this.options.db
      .select()
      .from(sessionAssets)
      .where(
        and(
          eq(sessionAssets.sessionId, options.sessionId),
          notExists(
            this.options.db
              .select({ id: newerSessionAssets.id })
              .from(newerSessionAssets)
              .where(
                and(
                  eq(newerSessionAssets.sessionId, sessionAssets.sessionId),
                  eq(newerSessionAssets.assetKey, sessionAssets.assetKey),
                  or(
                    gt(newerSessionAssets.messageCreatedAtMs, sessionAssets.messageCreatedAtMs),
                    and(
                      eq(newerSessionAssets.messageCreatedAtMs, sessionAssets.messageCreatedAtMs),
                      gt(newerSessionAssets.id, sessionAssets.id),
                    ),
                  ),
                ),
              )
              .limit(1),
          ),
          cursor
            ? or(
                lt(sessionAssets.messageCreatedAtMs, cursor.messageCreatedAtMs),
                and(
                  eq(sessionAssets.messageCreatedAtMs, cursor.messageCreatedAtMs),
                  lt(sessionAssets.id, cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(sessionAssets.messageCreatedAtMs), desc(sessionAssets.id))
      .limit(limit + 1)
      .all();
    const hasMore = all.length > limit;
    const rows = all.slice(0, limit);
    const assets = rows.map(assetRecord);
    return {
      assets,
      hasMore,
      ...(hasMore && rows.at(-1)
        ? { nextCursor: encodeAssetCursor(rows.at(-1) as typeof sessionAssets.$inferSelect) }
        : {}),
    };
  }

  async copyForMessagePrefix(input: SessionAssetCopyInput) {
    const targetRoot =
      input.mode === 'workspace-copy'
        ? await this.requireOwnedWorkspaceRoot(input.targetSessionId, input.targetWorkspaceDir)
        : undefined;
    const sourceRows = input.messageIds.flatMap((messageId) =>
      this.options.db
        .select()
        .from(sessionAssets)
        .where(
          and(
            eq(sessionAssets.sessionId, input.sourceSessionId),
            eq(sessionAssets.messageId, messageId),
          ),
        )
        .all(),
    );
    const existingTargetOwnership = new Set(
      this.options.db
        .select()
        .from(sessionAssets)
        .where(eq(sessionAssets.sessionId, input.targetSessionId))
        .all()
        .map((row) => assetOwnershipKey(row.messageId, row.assetKey, row.path)),
    );
    const copiedFiles = new Set<string>();
    try {
      const values = [] as Array<typeof sessionAssets.$inferInsert>;
      const outcomes: ForkAssetProjection[] = [];
      for (const row of sourceRows) {
        const path = row.path;
        const copy =
          input.mode === 'records-only'
            ? { path }
            : await copyAssetPathBestEffort(
                row,
                {
                  sourceRoot: input.sourceWorkspaceDir,
                  targetRoot,
                },
                existingTargetOwnership,
              );
        outcomes.push({
          messageId: row.messageId,
          assetKey: row.assetKey,
          ...(copy ? { targetPath: copy.path } : {}),
        });
        if (!copy) continue;
        if (copy.copiedPath) copiedFiles.add(copy.copiedPath);
        values.push({
          ...row,
          id: undefined,
          sessionId: input.targetSessionId,
          path: copy.path,
          dataJson: rewriteAssetPath(row.dataJson, path, copy.path),
        });
      }
      this.options.db.transaction(
        (tx) => {
          if (input.messageIds.length > 0) {
            tx.delete(sessionAssets)
              .where(
                and(
                  eq(sessionAssets.sessionId, input.targetSessionId),
                  inArray(sessionAssets.messageId, [...input.messageIds]),
                ),
              )
              .run();
          }
          for (const value of values)
            tx.insert(sessionAssets).values(value).onConflictDoNothing().run();
          reconcileForkDisplayAssets(tx, input.targetSessionId, outcomes);
          markAssetIndexCurrent(tx, input.targetSessionId, Date.now());
        },
        { behavior: 'immediate' },
      );
      return {
        mode: input.mode,
        ...(targetRoot ? { targetRoot } : {}),
        copiedPaths: [...copiedFiles],
      };
    } catch (error) {
      for (const file of copiedFiles) await removeFile(file);
      await this.deleteSession(input.targetSessionId);
      throw error;
    }
  }

  async probeCopy(input: {
    sessionId: string;
    mode?: 'records-only' | 'workspace-copy';
    targetRoot?: string;
    copiedPaths: readonly string[];
  }): Promise<boolean> {
    const expected = new Set(input.copiedPaths);
    if (expected.size !== input.copiedPaths.length) return false;
    const rows = this.options.db
      .select()
      .from(sessionAssets)
      .where(eq(sessionAssets.sessionId, input.sessionId))
      .all();
    if (input.mode === 'records-only') {
      return !input.targetRoot && expected.size === 0 && probeRecordOnlyAssetRows(rows);
    }
    const ownedRoot = await this.ownedAssetRoot(input.sessionId, input.targetRoot, input.mode);
    if (expected.size > 0 && !ownedRoot) return false;
    if (!pathsBelongToRoot(expected, ownedRoot)) return false;
    return input.mode === 'workspace-copy'
      ? probeWorkspaceAssetRows(rows, expected, ownedRoot)
      : probeLegacyAssetRows(rows, expected);
  }

  async compensateCopy(input: {
    sessionId: string;
    mode?: 'records-only' | 'workspace-copy';
    copiedPaths?: readonly string[];
    targetRoot?: string;
  }): Promise<void> {
    this.options.db.transaction((tx) => {
      removeForkDisplayAssets(tx, input.sessionId);
      tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, input.sessionId)).run();
      markAssetIndexCurrent(tx, input.sessionId, Date.now());
    });
    if (input.mode === 'records-only') return;
    const ownedRoot = await this.ownedAssetRoot(input.sessionId, input.targetRoot, input.mode);
    const copiedPaths = new Set(input.copiedPaths ?? []);
    if (ownedRoot && pathsBelongToRoot(copiedPaths, ownedRoot)) {
      for (const path of copiedPaths) await removeFile(path);
      if (input.mode === undefined) await removeEmptyDirectory(ownedRoot);
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.options.db.transaction((tx) => {
      tx.delete(sessionAssets).where(eq(sessionAssets.sessionId, sessionId)).run();
      tx.delete(sessionAssetIndexState)
        .where(eq(sessionAssetIndexState.sessionId, sessionId))
        .run();
    });
  }

  private async ownedAssetRoot(
    sessionId: string,
    claimedRoot: string | undefined,
    mode: 'records-only' | 'workspace-copy' | undefined,
  ): Promise<string | undefined> {
    const expectedRoot =
      mode === 'workspace-copy'
        ? await this.options.resolveSessionWorkspaceRoot?.(sessionId)
        : this.options.resolveLegacySessionAssetRoot?.(sessionId);
    if (!expectedRoot) return undefined;
    if (claimedRoot && resolve(claimedRoot) !== resolve(expectedRoot)) return undefined;
    return expectedRoot;
  }

  private async requireOwnedWorkspaceRoot(sessionId: string, claimedRoot: string): Promise<string> {
    const expectedRoot = await this.options.resolveSessionWorkspaceRoot?.(sessionId);
    if (!expectedRoot || resolve(claimedRoot) !== resolve(expectedRoot)) {
      throw new Error('Fork asset target does not match the child Session workspace');
    }
    return expectedRoot;
  }
}

type SessionAssetRow = typeof sessionAssets.$inferSelect;

async function copyAssetPathBestEffort(
  row: SessionAssetRow,
  roots: { readonly sourceRoot?: string; readonly targetRoot?: string },
  existingTargetOwnership: ReadonlySet<string>,
): Promise<{ readonly path: string; readonly copiedPath?: string } | undefined> {
  try {
    return await copyAssetPath(row, roots, existingTargetOwnership);
  } catch {
    return undefined;
  }
}

async function copyAssetPath(
  row: SessionAssetRow,
  roots: { readonly sourceRoot?: string; readonly targetRoot?: string },
  existingTargetOwnership: ReadonlySet<string>,
): Promise<{ readonly path: string; readonly copiedPath?: string }> {
  const path = row.path.trim();
  if (!isLocalAssetPath(path)) return { path };
  if (!roots.sourceRoot || !roots.targetRoot) {
    throw new Error('Session asset filesystem roots are unavailable');
  }
  const sourcePath = resolveContainedPath(roots.sourceRoot, path);
  const targetPath = resolveContainedPath(
    roots.targetRoot,
    relative(resolve(roots.sourceRoot), sourcePath),
  );
  if (await isExistingRegularAsset(targetPath)) {
    return existingTargetOwnership.has(assetOwnershipKey(row.messageId, row.assetKey, targetPath))
      ? { path: targetPath, copiedPath: targetPath }
      : { path: targetPath };
  }
  try {
    await copyRegularAsset(sourcePath, targetPath);
  } catch (error) {
    await removeFile(targetPath);
    throw error;
  }
  return { path: targetPath, copiedPath: targetPath };
}

function pathsBelongToRoot(paths: ReadonlySet<string>, targetRoot: string | undefined): boolean {
  if (!targetRoot) return true;
  const root = resolve(targetRoot);
  return [...paths].every((path) => isContainedRelativePath(relative(root, resolve(path))));
}

function isContainedRelativePath(relativePath: string): boolean {
  return !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath);
}

function probeRecordOnlyAssetRows(rows: readonly SessionAssetRow[]): boolean {
  return rows.every((row) => hasPersistedAssetPath(row.dataJson, row.path));
}

async function probeWorkspaceAssetRows(
  rows: readonly SessionAssetRow[],
  expectedCopiedPaths: ReadonlySet<string>,
  targetRoot: string | undefined,
): Promise<boolean> {
  if (!targetRoot) return rows.every((row) => !isLocalAssetPath(row.path));
  const projected = new Set<string>();
  for (const row of rows) {
    if (!isLocalAssetPath(row.path)) continue;
    projected.add(row.path);
    if (!pathsBelongToRoot(new Set([row.path]), targetRoot)) return false;
    if (!(await isRegularAsset(row.path))) return false;
    if (!hasPersistedAssetPath(row.dataJson, row.path)) return false;
  }
  return [...expectedCopiedPaths].every((path) => projected.has(path));
}

async function probeLegacyAssetRows(
  rows: readonly SessionAssetRow[],
  expected: ReadonlySet<string>,
): Promise<boolean> {
  const projected = new Set<string>();
  for (const row of rows) {
    if (!isLocalAssetPath(row.path)) continue;
    projected.add(row.path);
    if (!expected.has(row.path)) return false;
    if (!(await isRegularAsset(row.path))) return false;
    if (!hasPersistedAssetPath(row.dataJson, row.path)) return false;
  }
  return projected.size === expected.size && [...expected].every((path) => projected.has(path));
}

async function isRegularAsset(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function isExistingRegularAsset(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Fork asset target must be a regular file');
    }
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function hasPersistedAssetPath(dataJson: string, expectedPath: string): boolean {
  try {
    const data: unknown = JSON.parse(dataJson);
    return isRecord(data) && data.path === expectedPath;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function removeFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Compensation is best effort and followed by operation ownership probes.
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch {
    // A non-empty or already removed operation-owned directory needs no further action.
  }
}

function normalizedFromRow(row: MessageStorageRow): NormalizedDisplayMessage {
  decodeDisplayMessage(row);
  return {
    msgId: row.messageId,
    role: row.role,
    turnId: row.turnId,
    source: row.source,
    sourceContextJson: row.sourceContextJson,
    createdAtMs: row.createdAtMs,
    dataJson: row.dataJson,
  };
}

function assetRecord(row: typeof sessionAssets.$inferSelect): SessionAssetRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    messageId: row.messageId,
    messageCreatedAtMs: row.messageCreatedAtMs,
    assetKey: row.assetKey,
    sourceTag: row.sourceTag,
    path: row.path,
    name: row.name,
    assetType: row.assetType,
    dataJson: row.dataJson,
  };
}

function isLocalAssetPath(path: string): boolean {
  return (
    path.length > 0 &&
    !/^https?:\/\//iu.test(path) &&
    !/^data:/iu.test(path) &&
    !path.startsWith('drive://')
  );
}

function resolveContainedPath(root: string, assetPath: string): string {
  const candidate = resolve(isAbsolute(assetPath) ? assetPath : join(root, assetPath));
  const base = resolve(root);
  const rel = relative(base, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Session asset path escapes the owned root');
  }
  return candidate;
}

async function copyRegularAsset(sourcePath: string, targetPath: string): Promise<void> {
  const sourceInfo = await lstat(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink())
    throw new Error('Session asset must be a regular file');
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, targetPath);
}

function rewriteAssetPath(dataJson: string, sourcePath: string, targetPath: string): string {
  try {
    const value: unknown = JSON.parse(dataJson);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return dataJson;
    const copy = { ...value } as Record<string, unknown>;
    if (copy.path === sourcePath) copy.path = targetPath;
    return JSON.stringify(copy);
  } catch {
    return dataJson;
  }
}

function assetOwnershipKey(messageId: string, key: string, path: string): string {
  return `${messageId}\0${key}\0${path}`;
}

function messageContent(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' &&
    parsed !== null &&
    'msg_content' in parsed &&
    typeof parsed.msg_content === 'string'
    ? parsed.msg_content
    : '';
}

function normalizeLimit(value: number | undefined): number {
  return value && value > 0 ? Math.min(Math.floor(value), 200) : 50;
}

function assetKey(asset: {
  readonly path: string;
  readonly driveNodeId?: string;
  readonly artifactId?: string;
}): string {
  return asset.path.trim() || asset.driveNodeId?.trim() || asset.artifactId?.trim() || '';
}
