import { attachMigrationMetadataToSerializedTree } from './host-legacy-helpers.js';
import {
  normalizeCleanLocalSession as normalizeCleanLocalSessionRecord,
  replyLocalPermissionRequestResponse,
  serializeMigrationMetadata,
} from './host-support.js';
import type { LocalPermissionDecision } from './host-helpers.js';
import type { LocalPermissionRouteContext } from './routes/permissions.js';
import {
  serializeLocalSession,
  serializeLocalSessionTree,
} from './session-compat-serialization.js';
import type { LocalSessionRecord } from '../sessions/controller.js';

export interface SessionStateHostHandle {
  configGetter: () => { dataDir: string } & Record<string, unknown>;
  legacyMigrator: unknown;
  readSessionPinned?: (sessionId: string) => Promise<boolean>;
  getSessionById(sessionId: string): Promise<LocalSessionRecord | undefined>;
}

export async function hostSerializeSession(
  host: SessionStateHostHandle,
  session: LocalSessionRecord,
): Promise<Record<string, unknown>> {
  const serialized = await serializeLocalSession({
    session,
    dataDir: host.configGetter().dataDir,
    getSessionById: (sessionId) => host.getSessionById(sessionId),
  });
  serialized.pinned = (await host.readSessionPinned?.(session.sessionId)) ?? false;
  const migration = await (
    host.legacyMigrator as { getMigrationRecordForLocalSession?(id: string): Promise<unknown> }
  )?.getMigrationRecordForLocalSession?.(session.sessionId);
  if (!migration) return serialized;
  return { ...serialized, migration: serializeMigrationMetadata(migration as never) };
}

export function hostSerializeSessions(
  host: SessionStateHostHandle,
  sessions: LocalSessionRecord[],
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(sessions.map((session) => hostSerializeSession(host, session)));
}

export async function hostSerializeSessionTree(
  host: SessionStateHostHandle,
  sessions: LocalSessionRecord[],
  url: URL,
  agentName: string,
  getSessionById?: (sessionId: string) => Promise<LocalSessionRecord | undefined>,
  agentNames?: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const tree = await serializeLocalSessionTree({
    sessions,
    url,
    agentName,
    ...(agentNames ? { agentNames } : {}),
    dataDir: host.configGetter().dataDir,
    getSessionById: getSessionById ?? ((sessionId) => host.getSessionById(sessionId)),
  });
  return attachMigrationMetadataToSerializedTree(host.legacyMigrator as never, tree);
}

export async function hostNormalizeCleanLocalSession(
  host: SessionStateHostHandle,
  session: LocalSessionRecord,
): Promise<LocalSessionRecord | undefined> {
  return normalizeCleanLocalSessionRecord({
    session,
    legacyMigrator: host.legacyMigrator as never,
    normalizeStalePiSession: async (record) => record,
  });
}

export async function hostReplyLocalPermissionRequest(
  requestId: string,
  decision: LocalPermissionDecision,
  routeContext: LocalPermissionRouteContext,
): Promise<Response> {
  return replyLocalPermissionRequestResponse({ requestId, decision, routeContext });
}
