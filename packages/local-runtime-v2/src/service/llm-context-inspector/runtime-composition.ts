import { join, relative, sep } from 'node:path';

import type { SessionSystemOwner } from '../session-system/index.js';
import { composeLlmContextInspector, type ComposedInspector } from './initialize.js';
import type { AppDb } from '../../infra/db/client.js';

interface RuntimeInspectorOptions {
  readonly dataDir: string;
  readonly db: AppDb;
  readonly runtimeOwnerKind?: string;
}

export async function createRuntimeInspector(options: RuntimeInspectorOptions): Promise<{
  readonly inspector: ComposedInspector | undefined;
  bindSessionSystem(sessionSystem: SessionSystemOwner): void;
}> {
  let sessionSystem: SessionSystemOwner | undefined;
  const composition = composeLlmContextInspector({
    dataDir: options.dataDir,
    db: options.db,
    resolveSession: createInspectorSessionResolver(options.dataDir, () => sessionSystem),
    runtimeOwnerKind: options.runtimeOwnerKind,
  });
  const inspector = composition ? await composition : undefined;
  return {
    inspector,
    bindSessionSystem: (value) => {
      sessionSystem = value;
    },
  };
}

function createInspectorSessionResolver(
  dataDir: string,
  getSessionSystem: () => SessionSystemOwner | undefined,
) {
  return async (sessionId: string) => {
    const located = await getSessionSystem()?.historyLocations.resolveSession(sessionId);
    const session = located?.session;
    if (!session || !located) return undefined;
    return {
      sessionId: session.sessionId,
      ...(session.title ? { title: session.title } : {}),
      agentName: session.agentName,
      createdAtMs: session.createdAtMs,
      historyRelativeDir: relative(join(dataDir, 'v2', 'sessions'), located.paths.sessionDir)
        .split(sep)
        .join('/'),
    };
  };
}
