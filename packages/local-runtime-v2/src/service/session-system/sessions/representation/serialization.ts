import type { SessionRecord } from '../repo/contract.js';

export interface ToDaemonSessionOptions {
  readonly includeCompressed?: boolean;
}

export function toDaemonSession(
  session: SessionRecord,
  options?: ToDaemonSessionOptions,
): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    sessionType: session.sessionType === 'root' ? 1 : 0,
    frameworkType: session.runtime,
    title: session.title ?? null,
    workspaceDir: session.workspaceDir,
    ...runLocationFields(session),
    ...appModeFields(session),
    isDefaultWorkspace: session.isDefaultWorkspace === true,
    parentSessionId: session.parentSessionId ?? null,
    visibility: session.visibility ?? 'visible',
    ...purposeFields(session),
    ...modelFields(session),
    ...compressedFields(session, options),
    archived: session.archived,
    status: daemonStatus(session),
    createdAt: session.createdAtMs,
    updatedAt: session.updatedAtMs,
  };
}

function daemonStatus(session: SessionRecord): Record<string, unknown> {
  const status: Record<string, unknown> = { type: session.status };
  if (session.errorMessage) status.message = session.errorMessage;
  if (session.errorCode !== undefined) status.errorCode = session.errorCode;
  if (session.errorSource) status.errorSource = session.errorSource;
  if (session.errorDetail) status.errorDetail = session.errorDetail;
  if (session.errorProviderId) status.errorProviderId = session.errorProviderId;
  return status;
}

function runLocationFields(session: SessionRecord): Record<string, unknown> {
  return session.runLocation ? { runLocation: session.runLocation } : {};
}

function appModeFields(session: SessionRecord): Record<string, unknown> {
  return session.sessionType === 'branch' && session.appMode ? { appMode: session.appMode } : {};
}

function purposeFields(session: SessionRecord): Record<string, unknown> {
  return session.purpose ? { purpose: session.purpose } : {};
}

function modelFields(session: SessionRecord): Record<string, unknown> {
  const selectedModel = selectedModelFields(session);
  return {
    ...(session.effectiveModel !== undefined ? { effective_model: session.effectiveModel } : {}),
    ...(session.effectiveModelVariant !== undefined
      ? { effective_model_variant: session.effectiveModelVariant }
      : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
  };
}

function selectedModelFields(session: SessionRecord): Record<string, unknown> | undefined {
  const model = parseEffectiveModel(session.effectiveModel);
  if (!model) return undefined;
  return {
    ...model,
    ...modelVariantField(session),
    ...modelThinkingField(session),
    ...(session.effectiveModelContextWindow != null
      ? { context_limit: session.effectiveModelContextWindow }
      : {}),
  };
}

function parseEffectiveModel(
  effectiveModel: string | null | undefined,
): { readonly provider_id: string; readonly model_id: string } | undefined {
  if (typeof effectiveModel !== 'string') return undefined;
  const separator = effectiveModel.indexOf('/');
  if (separator <= 0 || separator === effectiveModel.length - 1) return undefined;
  return {
    provider_id: effectiveModel.slice(0, separator),
    model_id: effectiveModel.slice(separator + 1),
  };
}

function modelVariantField(session: SessionRecord): Record<string, unknown> {
  return session.effectiveModelVariant !== undefined && session.effectiveModelVariant !== null
    ? { variant: session.effectiveModelVariant }
    : {};
}

function modelThinkingField(session: SessionRecord): Record<string, unknown> {
  return session.effectiveModelThinking !== undefined && session.effectiveModelThinking !== null
    ? { thinking: session.effectiveModelThinking }
    : {};
}

function compressedFields(
  session: SessionRecord,
  options: ToDaemonSessionOptions | undefined,
): Record<string, unknown> {
  return options?.includeCompressed === false ? {} : { compressed: session.archived };
}
