import { createHmac } from 'node:crypto';

interface BoundedWriter {
  append(value: string): boolean;
  finish(): string | undefined;
}

export const DEFAULT_MAX_FINGERPRINT_BYTES = 16 * 1_024;

const MAX_SERIALIZE_DEPTH = 32;

export function fingerprintWithinBudget(
  secret: Buffer,
  value: unknown,
  maxBytes: number,
): string | undefined {
  const serialized = stableSerializeWithinBudget(value, maxBytes);
  return serialized === undefined ? undefined : fingerprint(secret, serialized);
}

export function fingerprint(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function stableSerializeWithinBudget(value: unknown, maxBytes: number): string | undefined {
  const parts: string[] = [];
  let bytes = 0;
  const writer: BoundedWriter = {
    append(part) {
      bytes += Buffer.byteLength(part);
      if (bytes > maxBytes) return false;
      parts.push(part);
      return true;
    },
    finish: () => (bytes <= maxBytes ? parts.join('') : undefined),
  };
  const seen = new Set<object>();
  return writeStableValue(value, writer, seen, 0) ? writer.finish() : undefined;
}

function writeStableValue(
  value: unknown,
  writer: BoundedWriter,
  seen: Set<object>,
  depth: number,
): boolean {
  if (depth > MAX_SERIALIZE_DEPTH) return false;
  if (value === null || typeof value === 'boolean') return writer.append(JSON.stringify(value));
  if (typeof value === 'number') {
    return Number.isFinite(value) ? writer.append(JSON.stringify(value)) : false;
  }
  if (typeof value === 'string') {
    if (value.length > DEFAULT_MAX_FINGERPRINT_BYTES) return false;
    return writer.append(JSON.stringify(value));
  }
  if (Array.isArray(value)) return writeStableArray(value, writer, seen, depth);
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return writeStableRecord(value, writer, seen, depth);
  }
  return false;
}

function writeStableArray(
  value: readonly unknown[],
  writer: BoundedWriter,
  seen: Set<object>,
  depth: number,
): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  let ok = writer.append('[');
  for (let index = 0; ok && index < value.length; index += 1) {
    if (index > 0) ok = writer.append(',');
    if (ok) ok = writeStableValue(value[index], writer, seen, depth + 1);
  }
  if (ok) ok = writer.append(']');
  seen.delete(value);
  return ok;
}

function writeStableRecord(
  value: Readonly<Record<string, unknown>>,
  writer: BoundedWriter,
  seen: Set<object>,
  depth: number,
): boolean {
  if (seen.has(value)) return false;
  seen.add(value);
  const keys: string[] = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (keys.length >= 1_024 || key.length > DEFAULT_MAX_FINGERPRINT_BYTES) return false;
    keys.push(key);
  }
  keys.sort();
  let ok = writer.append('{');
  for (let index = 0; ok && index < keys.length; index += 1) {
    const key = keys[index];
    if (key === undefined) continue;
    if (index > 0) ok = writer.append(',');
    if (ok) ok = writer.append(JSON.stringify(key));
    if (ok) ok = writer.append(':');
    if (ok) ok = writeStableValue(value[key], writer, seen, depth + 1);
  }
  if (ok) ok = writer.append('}');
  seen.delete(value);
  return ok;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`runawayGuardShadowExtension: ${field} must be a positive integer`);
  }
  return value;
}
