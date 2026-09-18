export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortJsonValue(value));
  if (serialized === undefined) invalidEnvelope('value is not JSON serializable');
  return serialized;
}

export function assertJsonCompatible(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): void {
  if (isJsonPrimitive(value)) return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidEnvelope(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') invalidEnvelope(`${path} contains a non-JSON value`);
  assertJsonCompatibleContainer(value, path, ancestors);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, sortJsonValue);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJsonValue(value[key])]),
  );
}

function isJsonPrimitive(value: unknown): value is null | string | boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

function assertJsonCompatibleContainer(value: object, path: string, ancestors: Set<object>): void {
  if (ancestors.has(value)) invalidEnvelope(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      assertJsonCompatibleArray(value, path, ancestors);
      return;
    }
    assertJsonCompatibleObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function assertJsonCompatibleArray(
  value: readonly unknown[],
  path: string,
  ancestors: Set<object>,
): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      invalidEnvelope(`${path}[${String(index)}] is a sparse array hole`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      invalidEnvelope(`${path}[${String(index)}] must be an enumerable data property`);
    }
    assertJsonCompatible(descriptor.value, `${path}[${String(index)}]`, ancestors);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isCanonicalArrayIndex(key, value.length)) {
      invalidEnvelope(`${path} contains a non-JSON array property`);
    }
  }
}

function assertJsonCompatibleObject(value: object, path: string, ancestors: Set<object>): void {
  if (!isPlainRecord(value)) invalidEnvelope(`${path} must contain only plain objects`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalidEnvelope(`${path} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      invalidEnvelope(`${path}.${key} must be an enumerable data property`);
    }
    assertJsonCompatible(descriptor.value, `${path}.${key}`, ancestors);
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/u.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function invalidEnvelope(reason: string): never {
  throw new Error(`Invalid canonical history envelope: ${reason}`);
}
