import { createHash, randomBytes } from 'node:crypto';
import fs, { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Derived test-status cache for BYOK model providers. Everything in this file
// is rebuildable from re-running connection tests; it must never contain API
// keys, request headers, or response bodies — only normalized states, error
// codes, sanitized messages, and Unix-ms timestamps.

export type ModelCacheState = 'unknown' | 'available' | 'failed';

export interface ModelCacheStatusEntry {
  state: ModelCacheState;
  /** Unix ms (repo rule: never ISO strings in storage). */
  last_tested_at?: number;
  last_error_code?: string;
  last_error_message?: string;
  /** SHA-256 of the effective provider + model request configuration. */
  config_fingerprint?: string;
}

export interface ModelCacheData {
  version: 3;
  provider_status: Record<string, ModelCacheStatusEntry>;
  model_status: Record<string, ModelCacheStatusEntry>;
}

const MODEL_CACHE_FILE = 'model-cache.json';
const CACHE_STATES = new Set<ModelCacheState>(['unknown', 'available', 'failed']);
const MAX_ERROR_MESSAGE_LENGTH = 500;
const mutationTails = new Map<string, Promise<void>>();

export function emptyModelCacheData(): ModelCacheData {
  return { version: 3, provider_status: {}, model_status: {} };
}

export function loadModelCacheData(dataDir: string): ModelCacheData {
  return loadModelCacheFile(resolve(dataDir, MODEL_CACHE_FILE));
}

function loadModelCacheFile(filePath: string): ModelCacheData {
  if (!existsSync(filePath)) return emptyModelCacheData();
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (!isPlainRecord(parsed)) return emptyModelCacheData();
    return {
      version: 3,
      provider_status: readStatusMap(parsed.provider_status),
      model_status: readStatusMap(parsed.model_status),
    };
  } catch {
    return emptyModelCacheData();
  }
}

export function modelCacheStatusFor(
  data: ModelCacheData,
  providerId: string,
  modelId: string,
  expectedFingerprint?: string,
): ModelCacheStatusEntry | undefined {
  const entry = data.model_status[`${providerId}/${modelId}`] ?? data.provider_status[providerId];
  if (expectedFingerprint !== undefined && entry?.config_fingerprint !== expectedFingerprint) {
    return undefined;
  }
  return entry;
}

export function modelConfigFingerprint(value: unknown): string {
  const canonical = JSON.stringify(sortForFingerprint(value));
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class LocalModelCache {
  constructor(private readonly getDataDir: () => string) {}

  load(): ModelCacheData {
    return loadModelCacheData(this.getDataDir());
  }

  async setProviderStatus(providerId: string, entry: ModelCacheStatusEntry): Promise<void> {
    await this.mutate((data) => {
      data.provider_status[providerId] = sanitizeEntry(entry);
    });
  }

  async setModelStatus(modelKey: string, entry: ModelCacheStatusEntry): Promise<void> {
    await this.replaceModelStatus(modelKey, entry);
  }

  async replaceModelStatus(
    modelKey: string,
    entry: ModelCacheStatusEntry,
  ): Promise<ModelCacheStatusEntry | undefined> {
    return this.mutate((data) => {
      const previous = data.model_status[modelKey];
      data.model_status[modelKey] = sanitizeEntry(entry);
      return previous;
    });
  }

  async restoreModelStatusIfCurrent(
    modelKey: string,
    expectedCurrent: ModelCacheStatusEntry,
    previous: ModelCacheStatusEntry | undefined,
  ): Promise<boolean> {
    return this.mutate((data) => {
      if (!statusEntriesEqual(data.model_status[modelKey], expectedCurrent)) return false;
      if (previous) data.model_status[modelKey] = sanitizeEntry(previous);
      else delete data.model_status[modelKey];
      return true;
    });
  }

  async removeModelStatus(modelKey: string): Promise<void> {
    await this.mutate((data) => {
      delete data.model_status[modelKey];
    });
  }

  async removeProvider(providerId: string): Promise<void> {
    await this.mutate((data) => {
      delete data.provider_status[providerId];
      for (const key of Object.keys(data.model_status)) {
        if (key.startsWith(`${providerId}/`)) delete data.model_status[key];
      }
    });
  }

  private async mutate<T>(mutate: (data: ModelCacheData) => T): Promise<T> {
    const filePath = resolve(this.getDataDir(), MODEL_CACHE_FILE);
    const previous = mutationTails.get(filePath) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const data = loadModelCacheFile(filePath);
        const result = mutate(data);
        await this.write(filePath, data);
        return result;
      });
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    mutationTails.set(filePath, tail);
    try {
      return await operation;
    } finally {
      if (mutationTails.get(filePath) === tail) mutationTails.delete(filePath);
    }
  }

  private async write(filePath: string, data: ModelCacheData): Promise<void> {
    await fs.promises.mkdir(dirname(filePath), { recursive: true });
    const tmpPath = join(dirname(filePath), `.model-cache-tmp-${randomBytes(6).toString('hex')}`);
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}

function statusEntriesEqual(
  left: ModelCacheStatusEntry | undefined,
  right: ModelCacheStatusEntry | undefined,
): boolean {
  if (!left || !right) return left === right;
  const normalizedLeft = sanitizeEntry(left);
  const normalizedRight = sanitizeEntry(right);
  return (
    normalizedLeft.state === normalizedRight.state &&
    normalizedLeft.last_tested_at === normalizedRight.last_tested_at &&
    normalizedLeft.last_error_code === normalizedRight.last_error_code &&
    normalizedLeft.last_error_message === normalizedRight.last_error_message &&
    normalizedLeft.config_fingerprint === normalizedRight.config_fingerprint
  );
}

function sanitizeEntry(entry: ModelCacheStatusEntry): ModelCacheStatusEntry {
  return {
    state: entry.state,
    ...(typeof entry.last_tested_at === 'number' ? { last_tested_at: entry.last_tested_at } : {}),
    ...(typeof entry.last_error_code === 'string' && entry.last_error_code
      ? { last_error_code: entry.last_error_code }
      : {}),
    ...(typeof entry.last_error_message === 'string' && entry.last_error_message
      ? { last_error_message: entry.last_error_message.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
      : {}),
    ...(typeof entry.config_fingerprint === 'string' && entry.config_fingerprint
      ? { config_fingerprint: entry.config_fingerprint }
      : {}),
  };
}

function sortForFingerprint(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForFingerprint);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortForFingerprint(value[key])]),
  );
}

function readStatusMap(value: unknown): Record<string, ModelCacheStatusEntry> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, ModelCacheStatusEntry> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isPlainRecord(raw)) continue;
    const state = raw.state;
    if (typeof state !== 'string' || !CACHE_STATES.has(state as ModelCacheState)) continue;
    out[key] = sanitizeEntry(raw as unknown as ModelCacheStatusEntry);
  }
  return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
