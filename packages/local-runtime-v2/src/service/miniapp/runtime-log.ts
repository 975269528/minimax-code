import type { MiniAppRuntimeLogEvent } from './contracts.js';

const STABLE_EVENT = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,5}$/u;
const SENSITIVE = /(?:apikey|token|password|secret|credential|authorization|cookie|privatekey)/u;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SENSITIVE_KEY =
  /(?:apikey|token|password|secret|credential|authorization|cookie|privatekey|path|url|uri)/u;

/** Keeps only stable event codes and non-sensitive field names; field values never cross IPC. */
export function sanitizeMiniAppRuntimeLogEvent(
  event: MiniAppRuntimeLogEvent,
): MiniAppRuntimeLogEvent {
  const sensitiveMessage = event.message
    .split('.')
    .some((part) => part === 'key' || SENSITIVE.test(part));
  const message =
    event.message.length <= 128 && STABLE_EVENT.test(event.message) && !sensitiveMessage
      ? event.message
      : '[REDACTED_EVENT]';
  const fieldKeys = [...new Set(event.fieldKeys)]
    .filter((key) => {
      if (!SAFE_KEY.test(key)) return false;
      return !SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ''));
    })
    .sort()
    .slice(0, 32);
  return Object.freeze({
    processGeneration: event.processGeneration,
    level: event.level,
    message,
    byteLength:
      Number.isFinite(event.byteLength) && event.byteLength >= 0 ? Math.floor(event.byteLength) : 0,
    fieldKeys: Object.freeze(fieldKeys),
  });
}
