import type { BaseInfo } from './ilink-types.js';

export const ILINK_CHANNEL_VERSION = '2.4.6';
export const ILINK_APP_ID = 'bot';
export const ILINK_BOT_AGENT = `Mavis/${ILINK_CHANNEL_VERSION}`;
export const ILINK_APP_CLIENT_VERSION = encodeIlinkClientVersion(ILINK_CHANNEL_VERSION);

export function encodeIlinkClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function buildIlinkCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

export function buildIlinkBaseInfo(): BaseInfo {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: ILINK_BOT_AGENT,
  };
}
