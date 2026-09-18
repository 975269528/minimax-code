import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EncryptedPromptEnvelope, PromptFileReader, PromptReadContext } from '../contracts.js';
import { decryptPromptEnvelope, promptCiphertextDigest } from './prompt-crypto.js';
import { PromptSnapshotInvalidError } from '../errors.js';
import { keyForPromptReadContext } from './read-context.js';
import { assertPromptRelativePath, promptPathWithin } from './prompt-path.js';

interface EncryptedManifest {
  readonly version: string;
  readonly cache_id: string;
  readonly storage_mode: 'encrypted';
  readonly key_version: string;
  readonly files: readonly EncryptedManifestFile[];
}

interface EncryptedManifestFile {
  readonly path: string;
  readonly envelope_path: string;
  readonly ciphertext_sha256: string;
}

export interface PromptFileReaderOptions {
  readonly maxCachedFiles?: number;
}

/** Reads either package files or encrypted version files without materializing plaintext on disk. */
export class LocalPromptFileReader implements PromptFileReader {
  private readonly manifestCache = new Map<string, EncryptedManifest>();
  private readonly plaintextCache = new Map<string, string>();
  private readonly maxCachedFiles: number;

  constructor(options: PromptFileReaderOptions = {}) {
    this.maxCachedFiles = options.maxCachedFiles ?? 128;
  }

  async read(context: PromptReadContext, relativePath: string): Promise<string | undefined> {
    assertPromptRelativePath(relativePath);
    if (context.storageMode !== 'encrypted') {
      return readOptionalFile(promptPathWithin(context.directory, relativePath));
    }
    const cacheKey = `${context.scopeId}\0${context.cacheId}\0${relativePath}`;
    const cached = this.plaintextCache.get(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const manifest = await this.readManifest(context);
      const entry = manifest.files.find((file) => file.path === relativePath);
      // Catalog locale and mode resolution probes optional fallback paths.
      // Bundle completeness is checked before activation; this reader only
      // reports that this optional lookup has no remote value.
      if (!entry) return undefined;
      const envelopePath = promptPathWithin(context.directory, entry.envelope_path);
      const envelope = parseEnvelope(await readFile(envelopePath, 'utf8'));
      if (
        envelope.path !== relativePath ||
        envelope.version !== context.version ||
        promptCiphertextDigest(envelope.ciphertext) !== entry.ciphertext_sha256
      ) {
        throw new PromptSnapshotInvalidError('Prompt envelope does not match its manifest');
      }
      const key = keyForPromptReadContext(context);
      if (!key) throw new PromptSnapshotInvalidError('Prompt snapshot key is unavailable');
      const content = decryptPromptEnvelope(envelope, { key, subject: context.subject });
      this.cache(cacheKey, content);
      return content;
    } catch (error) {
      if (error instanceof PromptSnapshotInvalidError) throw error;
      throw new PromptSnapshotInvalidError('Prompt encrypted file cannot be read');
    }
  }

  async validate(context: PromptReadContext): Promise<boolean> {
    if (context.storageMode !== 'encrypted') return true;
    try {
      const manifest = await this.readManifest(context);
      if (manifest.files.length === 0) {
        throw new PromptSnapshotInvalidError('Prompt manifest is empty');
      }
      for (const file of manifest.files) await this.read(context, file.path);
      return true;
    } catch {
      return false;
    }
  }

  clearCache(): void {
    this.manifestCache.clear();
    this.plaintextCache.clear();
  }

  private async readManifest(context: PromptReadContext): Promise<EncryptedManifest> {
    const cached = this.manifestCache.get(context.directory);
    if (cached) return cached;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(context.directory, 'manifest.json'), 'utf8'));
    } catch {
      throw new PromptSnapshotInvalidError('Prompt manifest cannot be read');
    }
    const manifest = parseManifest(parsed);
    if (
      !manifest ||
      manifest.version !== context.version ||
      manifest.cache_id !== context.cacheId ||
      manifest.key_version !== context.keyVersion
    ) {
      throw new PromptSnapshotInvalidError('Prompt manifest does not match its context');
    }
    this.manifestCache.set(context.directory, manifest);
    return manifest;
  }

  private cache(key: string, content: string): void {
    this.plaintextCache.delete(key);
    this.plaintextCache.set(key, content);
    while (this.plaintextCache.size > this.maxCachedFiles) {
      const oldest = this.plaintextCache.keys().next().value;
      if (oldest === undefined) return;
      this.plaintextCache.delete(oldest);
    }
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function parseManifest(value: unknown): EncryptedManifest | undefined {
  const header = parseManifestHeader(value);
  if (!header) return undefined;
  const files = header.files.map(parseManifestFile);
  if (files.some((file) => file === undefined)) return undefined;
  return {
    version: header.version,
    cache_id: header.cacheId,
    storage_mode: 'encrypted',
    key_version: header.keyVersion,
    files: files as EncryptedManifestFile[],
  };
}

function parseManifestHeader(value: unknown):
  | {
      readonly version: string;
      readonly cacheId: string;
      readonly keyVersion: string;
      readonly files: readonly unknown[];
    }
  | undefined {
  if (!isRecord(value) || value.storage_mode !== 'encrypted' || !Array.isArray(value.files)) {
    return undefined;
  }
  if (
    typeof value.version !== 'string' ||
    typeof value.cache_id !== 'string' ||
    typeof value.key_version !== 'string'
  ) {
    return undefined;
  }
  return {
    version: value.version,
    cacheId: value.cache_id,
    keyVersion: value.key_version,
    files: value.files,
  };
}

function parseManifestFile(value: unknown): EncryptedManifestFile | undefined {
  if (
    !isRecord(value) ||
    typeof value.path !== 'string' ||
    typeof value.envelope_path !== 'string' ||
    typeof value.ciphertext_sha256 !== 'string'
  ) {
    return undefined;
  }
  try {
    assertPromptRelativePath(value.path);
    assertPromptRelativePath(value.envelope_path);
  } catch {
    return undefined;
  }
  return {
    path: value.path,
    envelope_path: value.envelope_path,
    ciphertext_sha256: value.ciphertext_sha256,
  };
}

function parseEnvelope(value: string): EncryptedPromptEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new PromptSnapshotInvalidError('Prompt envelope cannot be parsed');
  }
  if (
    !isRecord(parsed) ||
    parsed.algorithm !== 'AES-256-GCM' ||
    typeof parsed.version !== 'string' ||
    typeof parsed.path !== 'string' ||
    typeof parsed.nonce !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new PromptSnapshotInvalidError('Prompt envelope is invalid');
  }
  return {
    algorithm: 'AES-256-GCM',
    version: parsed.version,
    path: parsed.path,
    nonce: parsed.nonce,
    ciphertext: parsed.ciphertext,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
