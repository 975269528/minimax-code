import type { CliService, SessionInfoView } from '@mavis/local-runtime-v2/cli-service';
import type {
  TuiAccountStatus,
  TuiEditMessageResult,
  TuiRewindPreview,
  TuiRewindResult,
  TuiRuntimeDiagnostics,
  TuiSession,
  TuiSessionInputSummary,
  TuiSessionModelSelection,
  TuiWorkspaceRoot,
} from '../port.js';

type CliGetSessionRewindPreviewResp = Awaited<ReturnType<CliService['getSessionRewindPreview']>>;
type CliListSessionInputSummariesResp = Awaited<
  ReturnType<CliService['listSessionInputSummaries']>
>;
type CliRewindSessionResp = Awaited<ReturnType<CliService['rewindSession']>>;
type CliEditSessionMessageResp = Awaited<ReturnType<CliService['editSessionMessage']>>;
type CliSessionInputSummaryView = NonNullable<
  CliListSessionInputSummariesResp['summaries']
>[number];

export function normalizeSessionInfoView(session: SessionInfoView): TuiSession {
  if (!session.sessionId) throw new Error('Runtime returned a Session without sessionId.');
  return compact({
    sessionId: session.sessionId,
    agentName: session.agentName,
    title: session.title,
    parentSessionId: session.parentSessionId,
    sessionType:
      session.sessionType === 1
        ? ('root' as const)
        : session.sessionType === 0
          ? ('branch' as const)
          : undefined,
    sessionKind: normalizeSessionKind(session.sessionKind),
    visibility: (session.visibility === 'hidden' || session.visibility === 'visible'
      ? session.visibility
      : undefined) as 'hidden' | 'visible' | undefined,
    purpose: session.purpose,
    archived: session.archived,
    workspaceDir: session.workspaceDir,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: normalizeSessionStatus(session.status?.statusType),
    errorMessage: session.status?.message,
    errorCode: session.status?.errorCode,
    errorSource: session.status?.errorSource,
    errorDetail: session.status?.errorDetail,
    errorProviderId: session.status?.errorProviderId,
    interactionMode: session.interactionMode === 1 ? ('plan' as const) : undefined,
    model: normalizeSessionModelSelection(session.model),
  });
}

/**
 * Session-scoped model echo. Only the fields the TUI actually renders are
 * kept: `thinking.effort` is the authoritative think-effort for the Session
 * because the model roster reports available options, never the chosen one.
 */
function normalizeSessionModelSelection(
  model: SessionInfoView['model'],
): TuiSessionModelSelection | undefined {
  if (!model) return undefined;
  const effort = model.thinking?.effort?.trim();
  const normalized: TuiSessionModelSelection = {
    ...(model.providerId ? { providerId: model.providerId } : {}),
    ...(model.modelId ? { modelId: model.modelId } : {}),
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
    ...(effort ? { thinking: { effort } } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeSessionStatus(status: number | undefined): string | undefined {
  switch (status) {
    case 0:
      return 'idle';
    case 1:
      return 'started';
    case 2:
      return 'error';
    case 3:
      return 'aborted';
    default:
      return undefined;
  }
}

function normalizeSessionKind(kind: number | undefined): string | undefined {
  switch (kind) {
    case 0:
      return 'unknown';
    case 1:
      return 'conversation';
    case 2:
      return 'task';
    case 3:
      return 'peek';
    case 4:
      return 'channel';
    case 5:
      return 'cron';
    default:
      return undefined;
  }
}

export function normalizeAccountStatus(raw: Record<string, unknown>): TuiAccountStatus {
  const selection = readRecord(raw.selection) ?? {};
  const provider = readRecord(raw.provider) ?? {};
  const auth = readRecord(raw.auth) ?? {};
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((warning): warning is string => typeof warning === 'string')
    : [];
  const authMode = readString(provider, ['authMode']);
  const managedTokenPresent = readBoolean(auth, ['tokenPresent']);
  const providerId = readString(selection, ['providerId']) ?? readString(provider, ['id']);
  const byokRoute = authMode !== undefined && authMode !== 'managed-login';
  const modelSource: TuiAccountStatus['modelSource'] =
    raw.modelSource === 'byok' || byokRoute
      ? 'byok'
      : raw.modelSource === 'token-plan'
        ? 'token-plan'
        : authMode === 'managed-login'
          ? 'token-plan'
          : providerId || authMode
            ? 'byok'
            : undefined;
  const needsLogin =
    (modelSource === 'token-plan' || (modelSource === undefined && authMode === 'managed-login')) &&
    managedTokenPresent !== true;
  const tokenPlanQuota = normalizeTokenPlanQuota(raw.tokenPlanQuota);
  const rawTokenPlanQuotaState =
    raw.tokenPlanQuotaState === 'available' ||
    raw.tokenPlanQuotaState === 'not-subscribed' ||
    raw.tokenPlanQuotaState === 'unavailable'
      ? raw.tokenPlanQuotaState
      : undefined;
  const tokenPlanQuotaState: TuiAccountStatus['tokenPlanQuotaState'] =
    rawTokenPlanQuotaState ??
    (modelSource === 'token-plan' ? (tokenPlanQuota ? 'available' : 'unavailable') : undefined);

  return compact({
    status: needsLogin
      ? ('needs-login' as const)
      : warnings.length > 0
        ? ('warning' as const)
        : authMode || readString(selection, ['defaultModel'])
          ? ('ready' as const)
          : ('unknown' as const),
    defaultModel: readString(selection, ['defaultModel']),
    providerId,
    modelId: readString(selection, ['modelId']),
    authMode,
    managedTokenPresent,
    modelSource,
    tokenPlanQuotaState,
    tokenPlanQuota,
    warnings,
  });
}

function normalizeTokenPlanQuota(value: unknown): TuiAccountStatus['tokenPlanQuota'] | undefined {
  const quota = readRecord(value);
  const fiveHour = normalizeTokenPlanQuotaWindow(quota?.fiveHour);
  const weekly = normalizeTokenPlanQuotaWindow(quota?.weekly);
  const video = normalizeTokenPlanVideoQuota(quota?.video);
  return fiveHour && weekly ? { fiveHour, weekly, ...(video ? { video } : {}) } : undefined;
}

function normalizeTokenPlanVideoQuota(
  value: unknown,
): NonNullable<TuiAccountStatus['tokenPlanQuota']>['video'] | undefined {
  const video = readRecord(value);
  if (!video || typeof video.unlimited !== 'boolean') return undefined;
  const remainingCount = readNumber(video, ['remainingCount']);
  const totalCount = readNumber(video, ['totalCount']);
  const resetAtMs = readNumber(video, ['resetAtMs']);
  return compact({
    remainingCount:
      remainingCount === undefined ? undefined : Math.round(Math.max(0, remainingCount)),
    totalCount: totalCount === undefined ? undefined : Math.round(Math.max(0, totalCount)),
    resetAtMs,
    unlimited: video.unlimited,
  });
}

function normalizeTokenPlanQuotaWindow(
  value: unknown,
): NonNullable<TuiAccountStatus['tokenPlanQuota']>['fiveHour'] | undefined {
  const window = readRecord(value);
  if (!window || typeof window.unlimited !== 'boolean') return undefined;
  const remainingPercent = readNumber(window, ['remainingPercent']);
  const resetAtMs = readNumber(window, ['resetAtMs']);
  return compact({
    remainingPercent:
      remainingPercent === undefined
        ? undefined
        : Math.round(Math.min(100, Math.max(0, remainingPercent))),
    resetAtMs,
    unlimited: window.unlimited,
  });
}

export function normalizeRuntimeDiagnostics(raw: Record<string, unknown>): TuiRuntimeDiagnostics {
  const runtimeOwner = readRecord(raw.runtimeOwner) ?? {};
  const paths = readRecord(raw.paths) ?? {};
  const selection = readRecord(raw.selection) ?? {};
  const provider = readRecord(raw.provider) ?? {};
  const auth = readRecord(raw.auth) ?? {};
  const byok = readRecord(raw.byok) ?? {};
  return compact({
    status: readString(raw, ['status']),
    surface: readString(raw, ['surface']),
    runtimeMode: readString(raw, ['runtimeMode']),
    runtimeOwnerKind: readString(runtimeOwner, ['kind']),
    runtimeOwnerId: readString(runtimeOwner, ['id']),
    dataDir: readString(paths, ['dataDir']),
    configPath: readString(paths, ['configPath']),
    configPresent: readBoolean(paths, ['configPresent']),
    authCachePresent: readBoolean(paths, ['authCachePresent']),
    defaultModel: readString(selection, ['defaultModel']),
    providerId: readString(selection, ['providerId']) ?? readString(provider, ['id']),
    modelId: readString(selection, ['modelId']),
    providerBaseUrl: readString(provider, ['baseURL']),
    authMode: readString(provider, ['authMode']),
    authModeSource: readString(provider, ['authModeSource']),
    managedTokenPresent: readBoolean(auth, ['tokenPresent']),
    apiKeyPresent: readBoolean(provider, ['apiKeyPresent']),
    customProviderCount: readNumber(byok, ['customProviderCount']),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [],
  });
}

export function normalizeWorkspaceRoots(roots: readonly TuiWorkspaceRoot[]): TuiWorkspaceRoot[] {
  const seen = new Set<string>();
  return roots.flatMap((root) => {
    const path = root.path.trim();
    if (!path || seen.has(path)) return [];
    seen.add(path);
    return [{ ...root, path }];
  });
}

export function interleave<T>(groups: readonly (readonly T[])[]): T[] {
  const output: T[] = [];
  const length = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < length; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (item !== undefined) output.push(item);
    }
  }
  return output;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key];
  }
  return undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key];
  }
  return undefined;
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}

/**
 * Wire-summary → TUI summary. The Runtime wraps each user prompt in
 * `SessionMessageHeadView` and the assistant response is optional; flatten
 * that into the TUI's row shape so the panel does not have to know about
 * the wire contract.
 *
 * `fileChangeCount` is optional on older rows and defensively coerces
 * missing / NaN / non-finite values to 0 because the TUI relies on it for a numeric
 * "files touched" badge.
 *
 * `timestamp` is passed through unchanged: the Runtime emits Unix
 * milliseconds (`ThriftI64 = number`) and the TUI's `productTime` helpers
 * consume the same unit.
 */
export function normalizeSessionInputSummaries(
  summaries: readonly CliSessionInputSummaryView[] | undefined,
): readonly TuiSessionInputSummary[] {
  if (!summaries) return [];
  return summaries.map((summary) => {
    const userInput = summary.userInput;
    const assistant = summary.assistantResponse;
    const count = summary.fileChangeCount;
    return {
      userMessageId: userInput.msgId,
      ...(assistant?.msgId ? { assistantMessageId: assistant.msgId } : {}),
      ...(userInput.contentHead !== undefined ? { contentHead: userInput.contentHead } : {}),
      timestamp: userInput.timestamp,
      fileChangeCount:
        typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0,
    } satisfies TuiSessionInputSummary;
  });
}

export function normalizeTuiRewindPreview(
  preview: CliGetSessionRewindPreviewResp,
): TuiRewindPreview {
  return {
    turns: preview.turns.map((turn) => ({
      turnId: turn.turnId,
      files: turn.files.map((file) => ({
        filePath: file.filePath,
        action: file.action,
        skipped: file.skipped === true,
      })),
    })),
  };
}

/**
 * Preserves the rewind outcome status and identifiers so the caller can build
 * user-facing partial-success messages. `deletedMessageIds` and the
 * `turnDiffRewind` envelope are optional on the wire; we keep them optional
 * here so the panel does not have to gate on `rewound` only.
 */
export function normalizeTuiRewindResult(response: CliRewindSessionResp): TuiRewindResult {
  return {
    rewound: response.rewound === true,
    ...(response.displayRevision !== undefined
      ? { displayRevision: response.displayRevision }
      : {}),
    ...(response.historyRevision !== undefined
      ? { historyRevision: response.historyRevision }
      : {}),
    ...(response.deletedMessageIds ? { deletedMessageIds: [...response.deletedMessageIds] } : {}),
    ...(response.turnDiffRewind
      ? {
          turnDiffRewind: {
            status: response.turnDiffRewind.status,
            ...(response.turnDiffRewind.revertedTurnIds
              ? { revertedTurnIds: [...response.turnDiffRewind.revertedTurnIds] }
              : {}),
            ...(response.turnDiffRewind.errorCode !== undefined
              ? { errorCode: response.turnDiffRewind.errorCode }
              : {}),
          },
        }
      : {}),
  };
}

export function normalizeTuiEditMessageResult(
  response: CliEditSessionMessageResp,
): TuiEditMessageResult {
  return {
    rewound: response.rewound === true,
    ...(response.turnId !== undefined ? { turnId: response.turnId } : {}),
    ...(response.userMessageId !== undefined ? { userMessageId: response.userMessageId } : {}),
    ...(response.displayRevision !== undefined
      ? { displayRevision: response.displayRevision }
      : {}),
    ...(response.historyRevision !== undefined
      ? { historyRevision: response.historyRevision }
      : {}),
    ...(response.deletedMessageIds ? { deletedMessageIds: [...response.deletedMessageIds] } : {}),
  };
}
