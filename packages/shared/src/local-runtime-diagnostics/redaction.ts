import type { ObservabilityRedactionPolicy } from './types.js';

const DEFAULT_POLICY_VERSION = 1;

export function isSensitiveObservabilityKey(key: string): boolean {
  return /api[-_]?key|token|secret|authorization|password|credential|signature|sig/i.test(key);
}

export function maskObservabilitySecret(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}

export function maskUrlCredentials(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = '****';
    if (parsed.password) parsed.password = '****';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveObservabilityKey(key)) parsed.searchParams.set(key, '****');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

export function sanitizeObservabilityText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/giu, (url) => maskUrlCredentials(url))
    .replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/giu, '$1****')
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|SIGNATURE|SIG)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^"',\s}]+/gu,
      '$1$2$3****',
    )
    .replace(
      /(["'])([^"']*(?:api[-_]?key|token|secret|authorization|password|credential|signature|sig)[^"']*)\1(\s*:\s*)(["']?)[^"',\s}]+/giu,
      '$1$2$1$3$4****',
    )
    .replace(
      /\b(api[-_]?key|token|secret|authorization|password|credential|signature|sig)\b(\s*[:=]\s*)(["']?)[^"',\s}]+/giu,
      '$1$2$3****',
    );
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (key === 'headers' && value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([headerKey, headerValue]) => [
        headerKey,
        typeof headerValue === 'string' ? maskObservabilitySecret(headerValue) : '****',
      ]),
    );
  }
  if (isSensitiveObservabilityKey(key)) {
    return typeof value === 'string' ? maskObservabilitySecret(value) : '****';
  }
  if (typeof value === 'string') return sanitizeObservabilityText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item));
  if (value && typeof value === 'object') return sanitizeRecord(value as Record<string, unknown>);
  return value;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
}

export function createDefaultObservabilityRedactionPolicy(): ObservabilityRedactionPolicy {
  return {
    policyVersion: DEFAULT_POLICY_VERSION,
    sanitizeValue,
    sanitizeFields: sanitizeRecord,
  };
}

export const DEFAULT_OBSERVABILITY_REDACTION_POLICY = createDefaultObservabilityRedactionPolicy();
