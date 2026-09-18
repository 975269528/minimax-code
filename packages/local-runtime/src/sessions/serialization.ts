import type { LocalSessionRecord } from './controller.js';

function modelFromSession(session: LocalSessionRecord): Record<string, unknown> | undefined {
  const key = session.effectiveModel;
  if (!key) return undefined;
  const separator = key.indexOf('/');
  if (separator <= 0 || separator >= key.length - 1) return undefined;
  return {
    provider_id: key.slice(0, separator),
    model_id: key.slice(separator + 1),
    ...(session.effectiveModelVariant !== undefined && session.effectiveModelVariant !== null
      ? { variant: session.effectiveModelVariant }
      : {}),
    ...(session.effectiveModelThinking !== undefined && session.effectiveModelThinking !== null
      ? { thinking: session.effectiveModelThinking }
      : {}),
  };
}

export function toDaemonSession(session: LocalSessionRecord): Record<string, unknown> {
  // PinService / pinned-items preferences own current pin state; session
  // records and this raw daemon projection do not carry pin facts.
  const model = modelFromSession(session);
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    sessionType: session.sessionType === 'root' ? 1 : 0,
    frameworkType: session.runtime,
    title: session.title ?? null,
    workspaceDir: session.workspaceDir,
    ...(session.runLocation ? { runLocation: session.runLocation } : {}),
    ...(session.sessionType === 'branch' && session.appMode ? { appMode: session.appMode } : {}),
    isDefaultWorkspace: session.isDefaultWorkspace === true,
    parentSessionId: session.parentSessionId ?? null,
    visibility: session.visibility ?? 'visible',
    ...(session.purpose ? { purpose: session.purpose } : {}),
    ...(session.effectiveModel !== undefined ? { effective_model: session.effectiveModel } : {}),
    ...(session.effectiveModelVariant !== undefined
      ? { effective_model_variant: session.effectiveModelVariant }
      : {}),
    ...(model ? { model } : {}),
    compressed: session.archived,
    archived: session.archived,
    status: {
      type: session.status,
      ...(session.errorMessage ? { message: session.errorMessage } : {}),
      ...(typeof session.errorCode === 'number' ? { errorCode: session.errorCode } : {}),
      ...(session.errorSource ? { errorSource: session.errorSource } : {}),
      ...(session.errorDetail ? { errorDetail: session.errorDetail } : {}),
      ...(session.errorProviderId ? { errorProviderId: session.errorProviderId } : {}),
      ...(session.canRetry !== undefined ? { canRetry: session.canRetry } : {}),
    },
    createdAt: session.createdAtMs,
    updatedAt: session.updatedAtMs,
  };
}
