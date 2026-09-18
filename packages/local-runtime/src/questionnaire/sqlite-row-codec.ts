import type {
  AskQuestionnaireReplyPayload,
  AskQuestionnaireRequest,
  AskQuestionnaireStatus,
} from '@mavis/shared/questionnaire';

import type { LocalMessageChannelContext } from '../messages/input.js';
import type { QuestionnaireRequestRecord } from './store.js';

export interface QuestionnaireRequestRow {
  request_id?: string;
  session_id?: string;
  agent_name?: string | null;
  msg_id?: string | null;
  origin_channel_context_json?: string | null;
  request_json?: string;
  status?: string;
  created_at?: number;
  answered_at?: number | null;
  reply_payload?: string | null;
  injected_at?: number | null;
  dismissed_at?: number | null;
}

export const QUESTIONNAIRE_ROW_SELECT = `
  request_id, session_id, agent_name, msg_id, origin_channel_context_json, request_json,
  status, created_at, answered_at, reply_payload, injected_at, dismissed_at
`;

export const QUALIFIED_QUESTIONNAIRE_ROW_SELECT = `
  qr.request_id, qr.session_id, qr.agent_name, qr.msg_id, qr.origin_channel_context_json,
  qr.request_json,
  qr.status, qr.created_at, qr.answered_at, qr.reply_payload, qr.injected_at,
  qr.dismissed_at
`;

export function toQuestionnaireRequestRecord(
  row: QuestionnaireRequestRow,
): QuestionnaireRequestRecord {
  const requestId = requireString(row.request_id, 'request_id');
  const sessionId = requireString(row.session_id, 'session_id');
  let request: AskQuestionnaireRequest;
  try {
    request = JSON.parse(
      requireString(row.request_json, 'request_json'),
    ) as AskQuestionnaireRequest;
  } catch {
    request = {
      schemaVersion: 2,
      id: requestId,
      presentation: {
        replaceComposer: true,
        showProgress: true,
        allowBackNavigation: true,
      },
      steps: [],
      status: 'expired',
      createdAt: Number(row.created_at ?? 0),
    };
  }

  let replyPayload: AskQuestionnaireReplyPayload | undefined;
  if (row.reply_payload) {
    try {
      replyPayload = JSON.parse(row.reply_payload) as AskQuestionnaireReplyPayload;
    } catch {
      replyPayload = undefined;
    }
  }

  const originChannelContext = parseQuestionnaireOriginChannelContext(
    row.origin_channel_context_json,
  );
  return {
    requestId,
    sessionId,
    ...(row.agent_name ? { agentName: row.agent_name } : {}),
    ...(row.msg_id ? { msgId: row.msg_id } : {}),
    ...(originChannelContext ? { originChannelContext } : {}),
    request,
    status: isValidStatus(row.status) ? row.status : 'pending',
    createdAt: Number(row.created_at ?? 0),
    ...(typeof row.answered_at === 'number' ? { answeredAt: row.answered_at } : {}),
    ...(replyPayload ? { replyPayload } : {}),
    ...(typeof row.injected_at === 'number' ? { injectedAt: row.injected_at } : {}),
    ...(typeof row.dismissed_at === 'number' ? { dismissedAt: row.dismissed_at } : {}),
  };
}

export function parseQuestionnaireOriginChannelContext(
  raw: string | null | undefined,
): LocalMessageChannelContext | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<LocalMessageChannelContext> | null;
    if (!value) return undefined;
    if (
      typeof value.platform !== 'string' ||
      typeof value.chatType !== 'string' ||
      typeof value.chatId !== 'string' ||
      typeof value.senderId !== 'string' ||
      typeof value.clientName !== 'string'
    ) {
      return undefined;
    }
    const threadId = typeof value.threadId === 'string' ? value.threadId : undefined;
    const sourceMessageId =
      typeof value.sourceMessageId === 'string' ? value.sourceMessageId : undefined;
    const contextToken = typeof value.contextToken === 'string' ? value.contextToken : undefined;
    return {
      platform: value.platform,
      chatType: value.chatType,
      chatId: value.chatId,
      senderId: value.senderId,
      clientName: value.clientName,
      ...(threadId ? { threadId } : {}),
      ...(sourceMessageId ? { sourceMessageId } : {}),
      ...(contextToken ? { contextToken } : {}),
    };
  } catch {
    return undefined;
  }
}

function isValidStatus(value: unknown): value is AskQuestionnaireStatus {
  return (
    value === 'pending' ||
    value === 'answered' ||
    value === 'expired' ||
    value === 'superseded' ||
    value === 'dismissed'
  );
}

function requireString(value: unknown, column: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`questionnaire_requests.${column} is missing`);
}

export function isOwnedActionRequestJson(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return isOwnedActionRequest(
      normalizePersistedQuestionnaireRequest(JSON.parse(raw) as AskQuestionnaireRequest),
    );
  } catch {
    return false;
  }
}

export function isOwnedActionRequest(request: Pick<AskQuestionnaireRequest, 'mode'>): boolean {
  return (
    typeof request.mode === 'string' &&
    request.mode !== 'questionnaire' &&
    request.mode !== 'feature-enable'
  );
}

export function toCompatibleQuestionnaireRequestRecord(
  row: QuestionnaireRequestRow,
): QuestionnaireRequestRecord {
  const record = toQuestionnaireRequestRecord(row);
  return {
    ...record,
    request: normalizePersistedQuestionnaireRequest(record.request),
  };
}

/**
 * Read-only compatibility for rows written before Questionnaire adopted
 * `mode` / `modePayload`. New writes remain canonical and old JSON is not
 * rewritten, so rollback keeps seeing its original storage contract.
 */
function normalizePersistedQuestionnaireRequest(
  request: AskQuestionnaireRequest,
): AskQuestionnaireRequest {
  if (typeof request.mode === 'string') return request;
  const { purpose, planReview, ...canonical } = request as AskQuestionnaireRequest & {
    purpose?: unknown;
    planReview?: unknown;
  };
  const legacyPurpose: unknown = purpose;
  if (legacyPurpose === 'plan_enter_confirmation') {
    return { ...canonical, mode: 'plan' };
  }
  if (legacyPurpose === 'plan_exit_review') {
    return {
      ...canonical,
      mode: 'plan',
      modePayload: { planReview: readPreModePlanReview(planReview) },
    };
  }
  return { ...canonical, mode: 'questionnaire' };
}

function readPreModePlanReview(value: unknown): {
  readonly markdown: string;
  readonly path: string;
} {
  const markdown =
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'markdown') === 'string'
      ? (Reflect.get(value, 'markdown') as string)
      : '';
  const path =
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'path') === 'string'
      ? (Reflect.get(value, 'path') as string)
      : '';
  // Keep incomplete persisted Plan reviews inside the Plan-owned recovery lane.
  // The owner validates both fields and fails closed instead of letting startup
  // recovery inject this row as an ordinary Questionnaire reply.
  return { markdown, path };
}
