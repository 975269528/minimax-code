import { decodeCronModel } from '@mavis/shared/cron-model';
import { createCronSessionPurpose, formatCronRunTitle } from '@mavis/shared/cron-purpose';

import type { SessionLifecycleService, SessionSystemOwner } from '../session-system/index.js';
import type { TurnService } from '../turn-system/index.js';
import { createHostCronSessionCreation } from './adapters/session-creation.adapter.js';
import type { CronSessionPorts } from './contracts.js';
import { deliverRuntimeCron } from './runtime-delivery.js';

export interface RuntimeCronSessionPortsOptions {
  readonly agentSessionPorts: RuntimeCronAgentSessionPorts;
  readonly sessions: SessionSystemOwner;
  readonly turns: Pick<TurnService, 'steer'>;
  readonly reportFailure: ((sessionId: string, message: string) => void) | undefined;
  readonly lifecycle: Pick<SessionLifecycleService, 'mutateSession'>;
  readonly deletion: {
    deleteTaskOwnedSessionById(sessionId: string): Promise<void>;
  };
  readonly resolveDefaultWorkspaceDir: () => string;
}

interface RuntimeCronAgentSessionPorts {
  readonly directory: {
    get(agentName: string): Promise<{ readonly defaultWorkspaceDir?: string } | undefined>;
  };
  readonly resolveWriteTarget: (requestRef: string) => Promise<string>;
}

/** Binds Cron's session ports to the V2 Agent, Session, and Turn capabilities. */
export function createRuntimeCronSessionPorts(
  options: RuntimeCronSessionPortsOptions,
): CronSessionPorts {
  const { agentSessionPorts, sessions, turns, reportFailure, lifecycle, deletion } = options;
  const sessionCreation = createHostCronSessionCreation({
    getAgent: async (agentName) => {
      const defaults = await agentSessionPorts.directory.get(agentName);
      return defaults
        ? {
            agentName,
            ...(defaults.defaultWorkspaceDir
              ? { defaultWorkspaceDir: defaults.defaultWorkspaceDir }
              : {}),
          }
        : undefined;
    },
    getSession: async (sessionId) => {
      const session = await sessions.sessions.repository.get(sessionId);
      return session
        ? { sessionId, agentName: session.agentName, archived: session.archived }
        : undefined;
    },
    resolveAgentWriteTarget: agentSessionPorts.resolveWriteTarget,
    createSession: async (request) => {
      const session = await sessions.sessions.records.createInternalSession({
        agentName: request.agentName,
        workspaceDir: request.workspaceDir,
        isDefaultWorkspace: request.isDefaultWorkspace,
        ...(request.model?.trim() ? sessionModelFields(request.model) : {}),
        sessionType: 'branch',
        sessionKind: 'cron',
        originCronId: request.cronId,
        purpose: createCronSessionPurpose(request.agentName, request.cronName),
        title: formatCronRunTitle(request.cronName, request.runCreatedAtMs),
      });
      return { sessionId: session.sessionId, agentName: session.agentName };
    },
    renameSession: async (sessionId, title) => {
      await lifecycle.mutateSession(sessionId, { title });
    },
    discardSession: async (sessionId) => {
      await deletion.deleteTaskOwnedSessionById(sessionId);
    },
    detachCronSessions: async (cronId, targetSessionId) => {
      await sessions.sessions.repository.detachCronSessions(cronId, targetSessionId);
    },
    resolveDefaultWorkspaceDir: options.resolveDefaultWorkspaceDir,
  });
  return {
    sessionCreation: {
      ...sessionCreation,
      async create(request) {
        const result = await sessionCreation.create(request);
        const model = request.model?.trim();
        if (
          request.sessionTarget.mode === 'sessionId' &&
          request.sessionTarget.sessionId &&
          model
        ) {
          const session = await sessions.sessions.repository.get(result.sessionId);
          const decoded = decodeCronModel(model);
          if (decoded.selection || session?.effectiveModel !== decoded.modelKey) {
            await lifecycle.mutateSession(result.sessionId, sessionModelFields(model));
          }
        }
        return result;
      },
    },
    delivery: {
      deliver: (request) => deliverRuntimeCron(turns, request, reportFailure),
    },
  };
}

/** New configurations replace all parameters; legacy keys keep the previous same-model policy. */
function sessionModelFields(model: string) {
  const { modelKey, selection } = decodeCronModel(model);
  return {
    effectiveModel: modelKey,
    effectiveModelVariant: selection?.variant ?? null,
    effectiveModelThinking: selection?.thinking ?? null,
    effectiveModelContextWindow: selection?.contextLimit ?? null,
    effectiveModelMaxOutputTokens: null,
  };
}
