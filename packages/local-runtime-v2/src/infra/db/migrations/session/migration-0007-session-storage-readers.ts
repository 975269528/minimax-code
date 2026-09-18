import type { MigrationEntry } from '../../migrate.js';

type Database = Parameters<Exclude<MigrationEntry['up'], string>>[0];

export function readCount(database: Database, sql: string): number {
  const row = database.prepare(sql).all()[0];
  if (!row) throw new Error('SQLite count query returned no row');
  return readInteger(row, 'count', 'SQLite count query');
}

export function parseJsonObject(raw: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${field} is not valid JSON`, { cause: error });
  }
  if (!isPlainObject(parsed)) throw new Error(`${field} must be an object`);
  return parsed;
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field}.${key} must be a string`);
  return value;
}

export function readOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
  field: string,
): string | null | undefined {
  const value = record[key];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') throw new Error(`${field}.${key} must be a string or null`);
  return value;
}

export function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  field: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field}.${key} must be a boolean`);
  return value;
}

export function readOptionalSafeInteger(
  record: Record<string, unknown>,
  key: string,
  field: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${field}.${key} must be a safe integer`);
  }
  return value;
}

export function readOptionalObject(
  record: Record<string, unknown>,
  key: string,
  field: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new Error(`${field}.${key} must be an object`);
  return value;
}

export function readOptionalEnum<const T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  field: string,
): T | undefined {
  const value = readOptionalString(record, key, field);
  if (value === undefined) return undefined;
  return requireEnum(value, allowed, `${field}.${key}`);
}

export function readLegacySessionType(
  record: Record<string, unknown>,
): 'root' | 'branch' | undefined {
  const value = readOptionalString(record, 'sessionType', 'record_json');
  if (value === undefined) return undefined;
  return requireCompatibleSessionType(value, 'record_json.sessionType');
}

export function requireCompatibleSessionType(
  value: string | null,
  field: string,
): 'root' | 'branch' {
  const compatible = requireEnum(value, ['root', 'branch', 'task'], field);
  return compatible === 'task' ? 'branch' : compatible;
}

export function requireEnum<const T extends string>(
  value: string | null,
  allowed: readonly T[],
  field: string,
): T {
  const result = allowed.find((candidate) => candidate === value);
  if (result === undefined) throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  return result;
}

export function requireNullableEnum<const T extends string>(
  value: string | null,
  allowed: readonly T[],
  field: string,
): T | null {
  return value === null ? null : requireEnum(value, allowed, field);
}

export function requireBit(value: number, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) throw new Error(`${field} must be 0 or 1`);
  return value;
}

export function readString(value: unknown, key: string, field: string): string {
  const result = readField(value, key, field);
  if (typeof result !== 'string') throw new Error(`${field}.${key} must be a string`);
  return result;
}

export function readNullableString(value: unknown, key: string, field: string): string | null {
  const result = readField(value, key, field);
  if (result === null) return null;
  if (typeof result !== 'string') throw new Error(`${field}.${key} must be a string or null`);
  return result;
}

export function readInteger(value: unknown, key: string, field: string): number {
  const result = readField(value, key, field);
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
    throw new Error(`${field}.${key} must be a safe integer`);
  }
  return result;
}

export function readPositiveSafeInteger(value: unknown, key: string, field: string): number {
  const result = readInteger(value, key, field);
  if (result <= 0) throw new Error(`${field}.${key} must be a positive safe integer`);
  return result;
}

export function readNullableInteger(value: unknown, key: string, field: string): number | null {
  const result = readField(value, key, field);
  if (result === null) return null;
  if (typeof result !== 'number' || !Number.isSafeInteger(result)) {
    throw new Error(`${field}.${key} must be a safe integer or null`);
  }
  return result;
}

export function readField(value: unknown, key: string, field: string): unknown {
  if (!isPlainObject(value) || !Object.hasOwn(value, key)) {
    throw new Error(`${field} is missing ${key}`);
  }
  return value[key];
}

export function requireItem<T>(values: readonly T[], index: number, field: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`${field} is missing item ${String(index)}`);
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
