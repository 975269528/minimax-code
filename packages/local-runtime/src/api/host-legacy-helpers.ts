import type { LegacyOpencodeMigrator } from '../legacy-opencode/legacy-opencode-migrator.js';
import { serializeMigrationMetadata } from './host-support.js';
import type { LocalSessionRecord } from '../sessions/controller.js';

export async function markMigratedLegacySessionDeleted(
  legacyMigrator: LegacyOpencodeMigrator | undefined,
  sessionId: string,
): Promise<boolean> {
  const record = await legacyMigrator?.markSessionDeleted(sessionId);
  return Boolean(record);
}

/**
 * Treat every legacy opencode session as a transparent native pi-agent session
 * for the user. All clean-mode mutation paths (PATCH title/workspaceDir, POST
 * archive/compress/pin/abort, queue/*, DELETE) are allowed regardless of the
 * underlying migration state — there is no "legacy session" surface left to
 * protect from the user's point of view. The legacy runtime (non-clean mode)
 * still keeps the legacy daemon as the source of truth, so sessions hosted
 * directly by it remain read-only at this boundary.
 */
export async function isReadOnlyLegacySession(
  _legacyMigrator: LegacyOpencodeMigrator | undefined,
  sessionOrId: LocalSessionRecord | string,
): Promise<boolean> {
  if (typeof sessionOrId !== 'string' && sessionOrId.runtime === 'opencode') return true;
  return false;
}

export async function attachMigrationMetadataToSerializedTree(
  legacyMigrator: LegacyOpencodeMigrator | undefined,
  tree: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const records = await legacyMigrator?.listMigrationRecords();
  if (!records?.length) return tree;
  const byLocalSessionId = new Map(records.map((record) => [record.localSessionId, record]));
  const decorate = (node: Record<string, unknown>): Record<string, unknown> => {
    const sessionId = typeof node['sessionId'] === 'string' ? node['sessionId'] : undefined;
    const migration = sessionId ? byLocalSessionId.get(sessionId) : undefined;
    const childSessions = Array.isArray(node['childSessions'])
      ? (node['childSessions'] as Array<Record<string, unknown>>).map(decorate)
      : node['childSessions'];
    return {
      ...node,
      ...(migration ? { migration: serializeMigrationMetadata(migration) } : {}),
      ...(childSessions !== undefined ? { childSessions } : {}),
    };
  };
  return tree.map(decorate);
}
