import { collectMessageAssetItems } from '@mavis/shared/asset-markup';
import { and, desc, eq } from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { messageRows, sessionAssetIndexState } from '../../../../infra/db/schema/messages.js';

export interface ForkAssetProjection {
  readonly messageId: string;
  readonly assetKey: string;
  readonly targetPath?: string;
}

export function reconcileForkDisplayAssets(
  db: AppDb,
  targetSessionId: string,
  outcomes: readonly ForkAssetProjection[],
): void {
  const byMessage = new Map<string, Map<string, string | undefined>>();
  for (const outcome of outcomes) {
    const replacements = byMessage.get(outcome.messageId) ?? new Map();
    replacements.set(outcome.assetKey, outcome.targetPath);
    byMessage.set(outcome.messageId, replacements);
  }
  for (const [messageId, replacements] of byMessage) {
    const row = db
      .select({ dataJson: messageRows.dataJson })
      .from(messageRows)
      .where(and(eq(messageRows.sessionId, targetSessionId), eq(messageRows.messageId, messageId)))
      .get();
    if (!row) continue;
    const nextDataJson = rewriteForkDisplayAssetData(row.dataJson, replacements);
    if (nextDataJson === row.dataJson) continue;
    db.update(messageRows)
      .set({ dataJson: nextDataJson })
      .where(and(eq(messageRows.sessionId, targetSessionId), eq(messageRows.messageId, messageId)))
      .run();
  }
}

export function removeForkDisplayAssets(db: AppDb, targetSessionId: string): void {
  const rows = db
    .select({ messageId: messageRows.messageId, dataJson: messageRows.dataJson })
    .from(messageRows)
    .where(eq(messageRows.sessionId, targetSessionId))
    .all();
  for (const row of rows) {
    const replacements = forkAssetRemovalMap(row.dataJson);
    if (replacements.size === 0) continue;
    const nextDataJson = rewriteForkDisplayAssetData(row.dataJson, replacements);
    db.update(messageRows)
      .set({ dataJson: nextDataJson })
      .where(
        and(eq(messageRows.sessionId, targetSessionId), eq(messageRows.messageId, row.messageId)),
      )
      .run();
  }
}

export function markAssetIndexCurrent(db: AppDb, sessionId: string, indexedAtMs: number): void {
  const latestRowId =
    db
      .select({ id: messageRows.id })
      .from(messageRows)
      .where(eq(messageRows.sessionId, sessionId))
      .orderBy(desc(messageRows.id))
      .limit(1)
      .get()?.id ?? 0;
  const state = {
    sessionId,
    indexVersion: 1,
    indexedThroughMessageRowId: latestRowId,
    indexedAtMs,
    status: 'ready',
    errorJson: null,
  };
  db.insert(sessionAssetIndexState)
    .values(state)
    .onConflictDoUpdate({ target: sessionAssetIndexState.sessionId, set: state })
    .run();
}

function rewriteForkDisplayAssetData(
  dataJson: string,
  replacements: ReadonlyMap<string, string | undefined>,
): string {
  try {
    const data: unknown = JSON.parse(dataJson);
    if (!isRecord(data) || typeof data.msg_content !== 'string') return dataJson;
    const msgContent = rewriteForkAssetMarkup(data.msg_content, replacements);
    return msgContent === data.msg_content
      ? dataJson
      : JSON.stringify({ ...data, msg_content: msgContent });
  } catch {
    return dataJson;
  }
}

function rewriteForkAssetMarkup(
  content: string,
  replacements: ReadonlyMap<string, string | undefined>,
): string {
  const rewriteToken = (token: string, wrapItem = false): string => {
    const parsed = collectMessageAssetItems(
      wrapItem ? `<deliver-assets>${token}</deliver-assets>` : token,
    )[0];
    if (!parsed) return token;
    const key = forkAssetKey(parsed);
    if (!replacements.has(key)) return token;
    const targetPath = replacements.get(key);
    return targetPath ? rewriteAssetTokenPath(token, parsed.path, targetPath) : '';
  };
  return content
    .replace(/<preview_card\b[^>]*>[\s\S]*?<\/preview_card>/giu, (token) => rewriteToken(token))
    .replace(/<item>[\s\S]*?<\/item>/giu, (token) => rewriteToken(token, true))
    .replace(/<media\s+[^>]*?\/>/giu, (token) => rewriteToken(token))
    .replace(/<(deliver-assets|deliver_assets)\b[^>]*>\s*<\/\1>/giu, '');
}

function forkAssetRemovalMap(dataJson: string): Map<string, undefined> {
  try {
    const data: unknown = JSON.parse(dataJson);
    if (!isRecord(data) || typeof data.msg_content !== 'string') return new Map();
    return new Map(
      collectMessageAssetItems(data.msg_content)
        .map(forkAssetKey)
        .filter((key) => key.length > 0)
        .map((key) => [key, undefined] as const),
    );
  } catch {
    return new Map();
  }
}

function forkAssetKey(asset: {
  readonly path: string;
  readonly driveNodeId?: string;
  readonly artifactId?: string;
}): string {
  return asset.path.trim() || asset.driveNodeId?.trim() || asset.artifactId?.trim() || '';
}

function rewriteAssetTokenPath(token: string, sourcePath: string, targetPath: string): string {
  if (sourcePath === targetPath) return token;
  const escaped = escapeAssetMarkupPath(targetPath);
  if (/<media\s/iu.test(token)) {
    return token.replace(/(\bsrc=")[^"]*(")/iu, `$1${escaped}$2`);
  }
  if (/<item>/iu.test(token)) {
    return token.replace(
      /(<path>)[\s\S]*?(?=<\/(?:path|name|type)>|<name>|<type>|<\/item>)/iu,
      `$1${escaped}`,
    );
  }
  return token.replace(/^(\s*path\s*:\s*).+$/imu, `$1${targetPath}`);
}

function escapeAssetMarkupPath(path: string): string {
  return path.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
