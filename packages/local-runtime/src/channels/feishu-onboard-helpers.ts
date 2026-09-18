export type OnboardStatus = 'app_pending' | 'user_pending' | 'done' | 'error';

export interface FeishuOnboardSession {
  sessionId: string;
  agentName: string;
  /** V2-only durable Connection owner; legacy Lark sessions leave this unset. */
  connectionId?: string;
  /** Exact transport client identity returned by the Feishu channel adapter. */
  clientName?: string;
  status: OnboardStatus;
  appDeviceCode?: string;
  userDeviceCode?: string;
  appId?: string;
  appSecret?: string;
  verificationUriComplete?: string;
  userCode?: string;
  expiresAtMs: number;
  intervalSec: number;
  userVerificationUriComplete?: string;
  userCodeFromCli?: string;
  userExpiresAtMs?: number;
  userIntervalSec?: number;
  userOpenId?: string;
  userName?: string;
  botBound?: boolean;
  error?: string;
  expired?: boolean;
  skipUserAuth: boolean;
  confirmedAtMs?: number;
}

export function serialize(session: FeishuOnboardSession, now: number): Record<string, unknown> {
  const expiresInSec = Math.max(0, Math.ceil((session.expiresAtMs - now) / 1000));
  const userExpiresInSec = session.userExpiresAtMs
    ? Math.max(0, Math.ceil((session.userExpiresAtMs - now) / 1000))
    : undefined;
  return {
    sessionId: session.sessionId,
    connectionId: session.connectionId,
    status: session.status,
    verificationUriComplete: session.verificationUriComplete,
    userCode: session.userCode,
    expiresIn: expiresInSec,
    expiresInSec,
    intervalSec: session.intervalSec,
    skipUserAuth: session.skipUserAuth,
    appId: session.appId,
    botBound: session.botBound === true,
    userOpenId: session.userOpenId,
    userName: session.userName,
    userVerificationUriComplete: session.userVerificationUriComplete,
    userCodeFromCli: session.userCodeFromCli,
    userExpiresInSec,
    userIntervalSec: session.userIntervalSec,
    error: session.error,
  };
}

export function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value[key];
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

export function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function readPositiveNumber(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const number = readNumber(value, key);
  return number !== undefined && number > 0 ? number : undefined;
}

export function isPendingText(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('authorization_pending') || lower.includes('slow_down');
}
