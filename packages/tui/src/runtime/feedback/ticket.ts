import { type MavisBuildEnv, type MavisRegion } from '@mavis/config';

import { redactTuiSensitiveText } from '../../user-facing-failure.js';
import type { TuiFeedbackReceipt } from '../port.js';
import { createPublicGatewayRequest, publicGatewayOrigin } from '../public-gateway.js';

const FEEDBACK_CLIENT_TYPE_DESKTOP = 1;

export interface FeedbackTicketDraft {
  readonly description: string;
  readonly sessionId?: string;
  readonly platform: { readonly platform: string; readonly osVersion: string };
  readonly diagnosticUploadId?: string;
}

export function feedbackEndpoint(input: {
  readonly endpoint?: string;
  readonly region?: () => MavisRegion;
  readonly buildEnv?: () => MavisBuildEnv;
}): string {
  if (input.endpoint) return input.endpoint;
  return `${publicGatewayOrigin(input)}/minimax-cloud/api/v1/feedback/ticket`;
}

export function feedbackPayload(
  draft: FeedbackTicketDraft,
  appVersion: string,
): Record<string, unknown> {
  return {
    description: draft.description,
    contact: '',
    task_context: {
      ...(draft.sessionId ? { session_id: draft.sessionId } : {}),
      client_type: FEEDBACK_CLIENT_TYPE_DESKTOP,
      client_version: cleanFeedbackText(appVersion),
      os: cleanFeedbackText(draft.platform.platform),
      os_version: cleanFeedbackText(draft.platform.osVersion),
    },
    screenshots: [],
    upload_diagnostic_log: Boolean(draft.diagnosticUploadId),
    ...(draft.diagnosticUploadId
      ? { diagnostic_log: { upload_id: draft.diagnosticUploadId } }
      : {}),
  };
}

export function feedbackRequest(input: {
  readonly endpoint: string;
  readonly payload: Record<string, unknown>;
  readonly token: string;
  readonly realUserID: string;
  readonly appVersion: string;
  readonly region: MavisRegion;
  readonly nowMs: number;
}): { readonly url: URL; readonly headers: Record<string, string>; readonly body: string } {
  const body = JSON.stringify(input.payload);
  const request = createPublicGatewayRequest({
    endpoint: input.endpoint,
    token: input.token,
    realUserID: input.realUserID,
    appVersion: cleanFeedbackText(input.appVersion),
    region: input.region,
    nowMs: input.nowMs,
    body,
  });
  return { ...request, body };
}

export function feedbackListRequest(input: {
  readonly endpoint: string;
  readonly token: string;
  readonly realUserID: string;
  readonly appVersion: string;
  readonly region: MavisRegion;
  readonly nowMs: number;
  readonly limit: number;
}): { readonly url: URL; readonly headers: Record<string, string> } {
  return createPublicGatewayRequest({
    endpoint: input.endpoint,
    token: input.token,
    realUserID: input.realUserID,
    appVersion: cleanFeedbackText(input.appVersion),
    region: input.region,
    nowMs: input.nowMs,
    query: { limit: String(input.limit) },
  });
}

export async function feedbackReceipt(response: Response): Promise<TuiFeedbackReceipt> {
  const body = await readJsonRecord(response);
  const data = readRecord(body.data);
  const statusInfo =
    readRecord(body.statusInfo) ??
    readRecord(body.status_info) ??
    readRecord(data?.statusInfo) ??
    readRecord(data?.status_info);
  const baseResp = readRecord(body.base_resp) ?? readRecord(data?.base_resp);
  if (
    (typeof statusInfo?.code === 'number' && statusInfo.code !== 0) ||
    (typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0)
  ) {
    throw new Error(feedbackBusinessDiagnostic(response.status, body, statusInfo, baseResp));
  }
  const ticketId = readString(body.ticket_id) ?? readString(data?.ticket_id);
  const status = body.status ?? data?.status;
  const createdAtMs = readFiniteNumber(body.created_at) ?? readFiniteNumber(data?.created_at);
  return {
    schemaVersion: 1,
    ...(ticketId ? { ticketId } : {}),
    status:
      status === 1 || status === 'processing'
        ? 'processing'
        : status === 2 || status === 'resolved'
          ? 'resolved'
          : 'unknown',
    ...(createdAtMs !== undefined ? { createdAtMs } : {}),
  };
}

export async function feedbackHttpDiagnostic(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  const trace = ['x-request-id', 'x-trace-id', 'trace-id']
    .flatMap((name) => {
      const value = response.headers.get(name)?.trim();
      return value ? [`${name}=${cleanFeedbackText(value)}`] : [];
    })
    .join('; ');
  return [
    `Feedback POST returned HTTP ${response.status}${response.statusText ? ` ${cleanFeedbackText(response.statusText)}` : ''}.`,
    ...(trace ? [`Trace: ${trace}.`] : []),
    `Response body: ${boundedFeedbackDiagnostic(body || '<empty>')}.`,
  ].join(' ');
}

export async function confirmFeedbackReceipt(
  response: Response,
  input: {
    readonly description: string;
    readonly submittedAtMs: number;
    readonly nowMs: number;
  },
): Promise<TuiFeedbackReceipt | undefined> {
  if (!response.ok) return undefined;
  const body = await readJsonRecord(response);
  const data = readRecord(body.data);
  if (hasBusinessError(body, data)) return undefined;
  const tickets = Array.isArray(body.tickets)
    ? body.tickets
    : Array.isArray(data?.tickets)
      ? data.tickets
      : [];
  const earliestCreatedAtMs = input.submittedAtMs - 5_000;
  const latestCreatedAtMs = input.nowMs + 30_000;
  for (const value of tickets) {
    const ticket = readRecord(value);
    if (!ticket || readString(ticket.description) !== input.description) continue;
    const ticketId = readString(ticket.ticket_id);
    const createdAtMs = readFiniteNumber(ticket.created_at);
    if (
      !ticketId ||
      createdAtMs === undefined ||
      createdAtMs < earliestCreatedAtMs ||
      createdAtMs > latestCreatedAtMs
    ) {
      continue;
    }
    return {
      schemaVersion: 1,
      ticketId,
      status: feedbackStatus(ticket.status),
      createdAtMs,
    };
  }
  return undefined;
}

export function cleanFeedbackText(value: string): string {
  return redactTuiSensitiveText(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ''),
  ).trim();
}

export function readUploadId(value: unknown): string | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return readString(value);
}

async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const text = await response.text();
    return text ? (readRecord(JSON.parse(text)) ?? {}) : {};
  } catch {
    return {};
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function hasBusinessError(
  body: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): boolean {
  const statusInfo =
    readRecord(body.statusInfo) ??
    readRecord(body.status_info) ??
    readRecord(data?.statusInfo) ??
    readRecord(data?.status_info);
  if (typeof statusInfo?.code === 'number' && statusInfo.code !== 0) return true;
  const baseResp = readRecord(body.base_resp) ?? readRecord(data?.base_resp);
  return typeof baseResp?.status_code === 'number' && baseResp.status_code !== 0;
}

function feedbackStatus(value: unknown): TuiFeedbackReceipt['status'] {
  if (value === 1 || value === 'processing') return 'processing';
  if (value === 2 || value === 'resolved') return 'resolved';
  return 'unknown';
}

function feedbackBusinessDiagnostic(
  httpStatus: number,
  body: Record<string, unknown>,
  statusInfo: Record<string, unknown> | undefined,
  baseResp: Record<string, unknown> | undefined,
): string {
  const details = [
    `HTTP ${httpStatus}`,
    ...(statusInfo?.code !== undefined ? [`statusInfo.code=${String(statusInfo.code)}`] : []),
    ...(statusInfo?.message !== undefined
      ? [`statusInfo.message=${cleanFeedbackText(String(statusInfo.message))}`]
      : []),
    ...(baseResp?.status_code !== undefined
      ? [`base_resp.status_code=${String(baseResp.status_code)}`]
      : []),
    ...(baseResp?.status_msg !== undefined
      ? [`base_resp.status_msg=${cleanFeedbackText(String(baseResp.status_msg))}`]
      : []),
  ];
  return `Feedback POST business rejection: ${details.join('; ')}. Response body: ${boundedFeedbackDiagnostic(JSON.stringify(body))}.`;
}

function boundedFeedbackDiagnostic(value: string): string {
  const clean = cleanFeedbackText(
    value.replace(
      /("(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret)"\s*:\s*)"[^"]*"/giu,
      '$1"[redacted]"',
    ),
  );
  const characters = Array.from(clean);
  return characters.length <= 4_000 ? clean : `${characters.slice(0, 4_000).join('')}… [truncated]`;
}
