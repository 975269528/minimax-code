import type { LocalSessionRecord } from '../sessions/controller.js';

export interface HostedSessionSnapshot {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly sessionType: 'root' | 'branch';
  readonly sessionKind?: string;
  readonly archived: boolean;
  readonly status: 'idle' | 'started' | 'error' | 'aborted' | 'interrupted';
  readonly isDefaultWorkspace?: boolean;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: 'visible' | 'hidden';
  readonly purpose?: string;
  readonly runLocation?: LocalSessionRecord['runLocation'];
  readonly appMode?: LocalSessionRecord['appMode'];
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly scratchpadPath?: string;
  readonly memoryPolicy?: {
    readonly recallEnabled: boolean;
    readonly writeEnabled: boolean;
    readonly recallLocked: boolean;
    readonly recallLockedAtMs?: number;
  };
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export function toLocalSessionRecord(session: HostedSessionSnapshot): LocalSessionRecord {
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    workspaceDir: session.workspaceDir,
    runtime: 'pi-agent',
    sessionType: session.sessionType,
    ...(session.sessionKind !== undefined ? { sessionKind: session.sessionKind } : {}),
    archived: session.archived,
    status: session.status,
    createdAtMs: session.createdAtMs,
    updatedAtMs: session.updatedAtMs,
    ...(session.isDefaultWorkspace !== undefined
      ? { isDefaultWorkspace: session.isDefaultWorkspace }
      : {}),
    ...(session.title !== undefined ? { title: session.title } : {}),
    ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.visibility ? { visibility: session.visibility } : {}),
    ...(session.purpose ? { purpose: session.purpose } : {}),
    ...(session.runLocation ? { runLocation: session.runLocation } : {}),
    ...(session.appMode ? { appMode: session.appMode } : {}),
    ...(session.effectiveModel !== undefined ? { effectiveModel: session.effectiveModel } : {}),
    ...(session.effectiveModelVariant !== undefined
      ? { effectiveModelVariant: session.effectiveModelVariant }
      : {}),
    ...(session.scratchpadPath ? { scratchpadPath: session.scratchpadPath } : {}),
  };
}
