/** Upload-safe error facts. Never serialize arbitrary values, property names or accessors. */
const ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'UnknownError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'APIError',
  'APICallError',
]);
const ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'rate_limit_exceeded',
  'insufficient_quota',
  'invalid_api_key',
  'context_length_exceeded',
]);

/** Reading data descriptors avoids invoking provider-controlled getters or toJSON. */
export function errorDataField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function snapshotErrorValue(value: unknown, _rootPath = ''): unknown {
  let remaining = 32;
  const seen = new WeakSet<object>();
  function visit(input: unknown, depth: number): Record<string, unknown> {
    if (depth > 4 || remaining-- <= 0) return { omitted: true };
    if (!input || typeof input !== 'object') return { name: 'UnknownError' };
    if (seen.has(input)) return { omitted: true };
    seen.add(input);
    if (errorDataField(input, 'omitted') === true) return { omitted: true };
    let name = errorDataField(input, 'name');
    // Built-in Error names live on the prototype; inspect data descriptors only.
    let prototype: object | null = input;
    for (let index = 0; name === undefined && prototype && index < 4; index += 1) {
      prototype = Object.getPrototypeOf(prototype);
      name = errorDataField(prototype, 'name');
    }
    const result: Record<string, unknown> = {
      name: typeof name === 'string' && ERROR_NAMES.has(name) ? name : 'Error',
    };
    for (const key of ['status', 'statusCode'] as const) {
      const status = errorDataField(input, key);
      if (
        typeof status === 'number' &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
      ) {
        result[key] = status;
      }
    }
    const code = errorDataField(input, 'code');
    if (typeof code === 'string' && ERROR_CODES.has(code)) result.code = code;
    // Only these structural edges are inspected. Headers, messages, stacks, request bodies,
    // custom fields (including their names), binary data, Maps and Sets never enter the log.
    for (const key of ['cause', 'error', 'properties'] as const) {
      const child = errorDataField(input, key);
      if (child && typeof child === 'object') result[key] = visit(child, depth + 1);
    }
    const errors = errorDataField(input, 'errors');
    if (Array.isArray(errors)) {
      result.errors = Array.from({ length: Math.min(errors.length, 8) }, (_, index) =>
        visit(errorDataField(errors, String(index)), depth + 1),
      );
    }
    return result;
  }
  try {
    return visit(value, 0);
  } catch {
    return { name: 'UnknownError' };
  }
}
