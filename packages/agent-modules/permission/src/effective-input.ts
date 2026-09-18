/**
 * Build the complete input that may execute after a permission decision.
 *
 * A checker may return only the fields it rewrites, while approval can keep
 * the decision pending long enough for either the original args or the
 * rewrite object to be mutated by another owner. Merge and deep-freeze a
 * detached JSON-like snapshot immediately after the decision so the eventual
 * executor input cannot drift while approval is pending.
 */
export function snapshotPermissionEffectiveInput(
  originalInput: Readonly<Record<string, unknown>>,
  rewrittenInput: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!rewrittenInput) return undefined;

  const merged = createPlainRecord();
  copyEnumerableDataProperties(originalInput, merged);
  copyEnumerableDataProperties(rewrittenInput, merged);
  return cloneAndFreeze(merged, new WeakSet()) as Readonly<Record<string, unknown>>;
}

/** Detach and deep-freeze a complete permission input without applying a rewrite. */
export function snapshotPermissionInput(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const copied = createPlainRecord();
  copyEnumerableDataProperties(input, copied);
  return cloneAndFreeze(copied, new WeakSet()) as Readonly<Record<string, unknown>>;
}

function cloneAndFreeze(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) {
    throw new TypeError('Permission effective input must not contain cyclic values.');
  }
  ancestors.add(value);

  let cloned: unknown;
  if (Array.isArray(value)) {
    cloned = value.map((item) => cloneAndFreeze(item, ancestors));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Permission effective input must contain only JSON-like values.');
    }
    const record = createPlainRecord();
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) {
        throw new TypeError('Permission effective input must not contain accessors.');
      }
      defineEnumerableValue(record, key, cloneAndFreeze(descriptor.value, ancestors));
    }
    cloned = record;
  }

  ancestors.delete(value);
  return Object.freeze(cloned);
}

function copyEnumerableDataProperties(
  source: Readonly<Record<string, unknown>>,
  target: Record<PropertyKey, unknown>,
): void {
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable) continue;
    if (!('value' in descriptor)) {
      throw new TypeError('Permission effective input must not contain accessors.');
    }
    defineEnumerableValue(target, key, descriptor.value);
  }
}

function createPlainRecord(): Record<PropertyKey, unknown> {
  return {} as Record<PropertyKey, unknown>;
}

function defineEnumerableValue(
  target: Record<PropertyKey, unknown>,
  key: PropertyKey,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
