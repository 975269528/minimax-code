export const MAX_CONSOLE_ARGUMENTS = 50;
const MAX_CONSOLE_ARGUMENT_CHARS = 8 * 1024;
const MAX_CONSOLE_ARGUMENT_AGGREGATE_CHARS = 16 * 1024;
export const MAX_CONSOLE_MESSAGE_CHARS = 4_000;
const MAX_CONSOLE_URL_CHARS = 2_048;
const MAX_STRUCTURED_REDACTION_DEPTH = 12;
const MAX_STRUCTURED_REDACTION_NODES = 1_000;

const SENSITIVE_KEY_PATTERN =
  'authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password';
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'clientsecret',
  'password',
]);

export function truncateConsoleValue(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function sanitizeConsoleDiagnosticUrl(value: string): string {
  const withoutSecrets = (() => {
    try {
      const url = new URL(value);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/iu, '$1').replace(/[?#].*$/u, '');
    }
  })();
  return truncateConsoleValue(withoutSecrets, MAX_CONSOLE_URL_CHARS);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_]/gu, ''));
}

function redactStructuredCredentials(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;

  const stack: Array<{ value: Record<string, unknown> | unknown[]; depth: number }> = [
    { value: value as Record<string, unknown> | unknown[], depth: 0 },
  ];
  let visitedNodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    visitedNodes += 1;
    if (
      visitedNodes > MAX_STRUCTURED_REDACTION_NODES ||
      current.depth > MAX_STRUCTURED_REDACTION_DEPTH
    ) {
      return false;
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        if (item && typeof item === 'object') {
          stack.push({
            value: item as Record<string, unknown> | unknown[],
            depth: current.depth + 1,
          });
        }
      }
      continue;
    }

    for (const [key, item] of Object.entries(current.value)) {
      if (isSensitiveKey(key)) {
        current.value[key] = '[REDACTED]';
      } else if (item && typeof item === 'object') {
        stack.push({
          value: item as Record<string, unknown> | unknown[],
          depth: current.depth + 1,
        });
      }
    }
  }

  return true;
}

function sanitizeStructuredConsoleMessage(value: string): string | null {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!redactStructuredCredentials(parsed)) return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function redactQuotedCredentialFields(value: string): string {
  const quotedField = new RegExp(
    `(["'])(${SENSITIVE_KEY_PATTERN})\\1(\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`,
    'giu',
  );
  return value.replace(quotedField, (_match, keyQuote, key, separator, quotedValue) => {
    const valueQuote = String(quotedValue).slice(0, 1);
    return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`;
  });
}

export function sanitizeConsoleMessage(value: string): string {
  const structured = sanitizeStructuredConsoleMessage(value);
  return redactQuotedCredentialFields(structured ?? value)
    .replace(/\b(?:https?|wss?|file):\/\/[^\s<>"']+/giu, (url) => sanitizeConsoleDiagnosticUrl(url))
    .replace(
      new RegExp(
        `\\b(authorization|cookie|set-cookie)\\s*[:=]\\s*[^\\r\\n]*?(?=\\s+\\b(?:${SENSITIVE_KEY_PATTERN})\\b\\s*[:=]|[\\r\\n]|$)`,
        'giu',
      ),
      '$1: [REDACTED]',
    )
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&}\]]+)/giu,
      '$1$2[REDACTED]',
    );
}

export function buildBoundedConsoleDiagnosticMessage(
  values: readonly string[],
  fallback: string,
): string {
  return truncateConsoleValue(
    sanitizeConsoleMessage(collectBoundedConsoleArgumentText(values) || fallback),
    MAX_CONSOLE_MESSAGE_CHARS,
  );
}

export function collectBoundedConsoleArgumentText(values: readonly string[]): string {
  const parts: string[] = [];
  let remainingChars = MAX_CONSOLE_ARGUMENT_AGGREGATE_CHARS;

  for (const value of values.slice(0, MAX_CONSOLE_ARGUMENTS)) {
    if (remainingChars <= 0) break;
    const separatorChars = parts.length > 0 ? 1 : 0;
    if (remainingChars <= separatorChars) break;
    const boundedValue = value.slice(
      0,
      Math.min(MAX_CONSOLE_ARGUMENT_CHARS, remainingChars - separatorChars),
    );
    parts.push(boundedValue);
    remainingChars -= separatorChars + boundedValue.length;
  }

  return parts.join(' ');
}
