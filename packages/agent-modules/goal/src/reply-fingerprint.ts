import { createHash } from 'node:crypto';

/**
 * Build the durable no-progress fingerprint for one main-worker reply.
 * Line endings and outer whitespace are presentation variance; all inner
 * content remains semantic and is hashed verbatim.
 */
export function fingerprintThreadGoalReply(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalized = text.replace(/\r\n?|\n/gu, '\n').trim();
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}
