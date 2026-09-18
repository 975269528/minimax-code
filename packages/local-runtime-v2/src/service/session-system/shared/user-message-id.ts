import { createHash } from 'node:crypto';

export type UserMessageId = `msg-user-v1-${string}`;

const USER_MESSAGE_ID_PREFIX = 'msg-user-v1-';
const USER_MESSAGE_ID_RE = /^msg-user-v1-[A-Za-z0-9_-]+$/;

export function createUserMessageId(input: {
  readonly sessionId: string;
  readonly messageKey: string;
}): UserMessageId {
  if (!input.sessionId) throw new Error('sessionId is required');
  if (!input.messageKey) throw new Error('messageKey is required');
  const digest = createHash('sha256')
    .update(input.sessionId)
    .update('\0')
    .update(input.messageKey)
    .digest('base64url');
  return `${USER_MESSAGE_ID_PREFIX}${digest}` as UserMessageId;
}

export function parseUserMessageId(value: unknown): UserMessageId | undefined {
  return typeof value === 'string' && USER_MESSAGE_ID_RE.test(value)
    ? (value as UserMessageId)
    : undefined;
}

export function isUserMessageId(value: unknown): value is UserMessageId {
  return parseUserMessageId(value) !== undefined;
}
