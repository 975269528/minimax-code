import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { replaceFileAtomically } from '../../../infra/file/jsonl.js';
import type {
  EncryptedPromptBundle,
  PromptConfigPointer,
  PromptStorageMode,
} from '../contracts.js';
import { PromptConfigError } from '../errors.js';
import { promptCiphertextDigest } from './prompt-crypto.js';
import {
  assertPromptRelativePath,
  assertPromptScope,
  promptCacheDirectoryName,
  promptPathWithin,
} from './prompt-path.js';

interface StoredPromptManifest {
  readonly version: string;
  readonly cache_id: string;
  readonly storage_mode: 'encrypted';
  readonly key_version: string;
  readonly files: readonly {
    readonly path: string;
    readonly envelope_path: string;
    readonly ciphertext_sha256: string;
  }[];
}

interface StoredPromptPointer {
  readonly version: string;
  readonly cache_id: string;
  readonly directory: string;
  readonly storage_mode: PromptStorageMode;
  readonly key_version: string;
  readonly last_checked_at_ms?: number;
}

export interface EncryptedPromptStorageOptions {
  readonly dataDir: string;
  readonly builtinAssetsDir: string;
}

export class EncryptedPromptStorage {
  constructor(private readonly options: EncryptedPromptStorageOptions) {}

  async ensureBuiltin(scopeId: string, keyVersion: string): Promise<PromptConfigPointer> {
    const root = this.scopeRoot(scopeId);
    const builtinDirectory = join(root, 'versions', 'builtin');
    await mkdir(join(root, 'versions'), { recursive: true, mode: 0o700 });
    if (!(await exists(builtinDirectory))) {
      const stagingDirectory = join(root, 'versions', `.builtin-${randomUUID()}`);
      try {
        await copyBuiltinAssets(this.options.builtinAssetsDir, stagingDirectory);
        await rename(stagingDirectory, builtinDirectory);
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true });
        throw error;
      }
    }
    const current = await this.readCurrent(scopeId);
    if (current) return current;
    const pointer = builtinPointer(builtinDirectory, keyVersion);
    await this.writeCurrent(scopeId, pointer);
    return pointer;
  }

  async readCurrent(scopeId: string): Promise<PromptConfigPointer | undefined> {
    const root = this.scopeRoot(scopeId);
    const pointerPath = join(root, 'current.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(pointerPath, 'utf8'));
    } catch (error) {
      if (isMissing(error)) return undefined;
      return undefined;
    }
    const pointer = parsePointer(parsed);
    if (!pointer) return undefined;
    if (!pointer.directory.startsWith('versions/')) return undefined;
    const resolvedDirectory = resolve(root, pointer.directory);
    const versionsRoot = resolve(root, 'versions');
    if (!isWithin(versionsRoot, resolvedDirectory) || !(await exists(resolvedDirectory))) {
      return undefined;
    }
    return { ...pointer, directory: resolvedDirectory };
  }

  async activateBuiltin(
    scopeId: string,
    keyVersion: string,
    nowMs: number,
  ): Promise<PromptConfigPointer> {
    const directory = join(this.scopeRoot(scopeId), 'versions', 'builtin');
    if (!(await exists(directory))) {
      throw new PromptConfigError(
        'PROMPT_BUILTIN_MISSING',
        'Builtin prompt directory is unavailable',
      );
    }
    const pointer = { ...builtinPointer(directory, keyVersion), lastCheckedAtMs: nowMs };
    await this.writeCurrent(scopeId, pointer);
    return pointer;
  }

  /** Returns the packaged fallback without changing the active version pointer. */
  async captureBuiltin(scopeId: string, keyVersion: string): Promise<PromptConfigPointer> {
    await this.ensureBuiltin(scopeId, keyVersion);
    return builtinPointer(join(this.scopeRoot(scopeId), 'versions', 'builtin'), keyVersion);
  }

  async markChecked(scopeId: string, nowMs: number): Promise<PromptConfigPointer | undefined> {
    const current = await this.readCurrent(scopeId);
    if (!current) return undefined;
    const pointer = { ...current, lastCheckedAtMs: nowMs };
    await this.writeCurrent(scopeId, pointer);
    return pointer;
  }

  async persistEncrypted(input: {
    readonly scopeId: string;
    readonly bundle: EncryptedPromptBundle;
    readonly cacheId: string;
    readonly rawPayload: string;
    readonly nowMs: number;
    /** Checked immediately before changing the active pointer. */
    readonly canActivate?: () => boolean;
  }): Promise<PromptConfigPointer> {
    const root = this.scopeRoot(input.scopeId);
    const directoryName = promptCacheDirectoryName(input.cacheId);
    const versionsRoot = join(root, 'versions');
    const targetDirectory = join(versionsRoot, directoryName);
    const stagingDirectory = join(versionsRoot, `.staging-${randomUUID()}`);
    await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'downloads'), { recursive: true, mode: 0o700 });

    const manifest = createManifest(input.bundle, input.cacheId);
    const downloadPath = join(root, 'downloads', `${directoryName}.json`);
    await replaceFileAtomically(downloadPath, input.rawPayload);

    await mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
    try {
      await writeFile(join(stagingDirectory, 'manifest.json'), JSON.stringify(manifest), {
        encoding: 'utf8',
        mode: 0o600,
      });
      for (const envelope of input.bundle.files) {
        const envelopePath = promptPathWithin(
          join(stagingDirectory, 'files'),
          `${envelope.path}.enc`,
        );
        await mkdir(dirname(envelopePath), { recursive: true, mode: 0o700 });
        await writeFile(envelopePath, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      }
      await verifyStaging(stagingDirectory, manifest);
      if (await exists(targetDirectory)) {
        await verifyStaging(targetDirectory, manifest);
        await rm(stagingDirectory, { recursive: true, force: true });
      } else {
        await rename(stagingDirectory, targetDirectory);
      }
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }

    const pointer: PromptConfigPointer = {
      version: input.bundle.version,
      cacheId: input.cacheId,
      directory: targetDirectory,
      storageMode: 'encrypted',
      keyVersion: input.bundle.keyVersion,
      lastCheckedAtMs: input.nowMs,
    };
    if (input.canActivate && !input.canActivate()) {
      throw new PromptConfigError(
        'PROMPT_AUTH_STALE',
        'Prompt response belongs to an inactive identity',
      );
    }
    await this.writeCurrent(input.scopeId, pointer);
    return pointer;
  }

  private scopeRoot(scopeId: string): string {
    assertPromptScope(scopeId);
    return join(this.options.dataDir, 'v2', 'prompts', scopeId);
  }

  private async writeCurrent(scopeId: string, pointer: PromptConfigPointer): Promise<void> {
    const root = this.scopeRoot(scopeId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const relativeDirectory = relative(root, pointer.directory).replaceAll('\\', '/');
    if (!relativeDirectory || relativeDirectory.startsWith('../')) {
      throw new PromptConfigError('PROMPT_POINTER_INVALID', 'Prompt pointer directory is invalid');
    }
    const payload: StoredPromptPointer = {
      version: pointer.version,
      cache_id: pointer.cacheId,
      directory: relativeDirectory,
      storage_mode: pointer.storageMode,
      key_version: pointer.keyVersion,
      ...(pointer.lastCheckedAtMs !== undefined
        ? { last_checked_at_ms: pointer.lastCheckedAtMs }
        : {}),
    };
    await replaceFileAtomically(join(root, 'current.json'), JSON.stringify(payload));
  }
}

async function copyBuiltinAssets(sourceDirectory: string, targetDirectory: string): Promise<void> {
  await mkdir(targetDirectory, { recursive: false, mode: 0o700 });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const source = join(sourceDirectory, entry.name);
    const target = join(targetDirectory, entry.name);
    if (entry.isDirectory()) {
      await copyBuiltinAssets(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target);
    } else {
      throw new Error(`Unsupported builtin prompt asset entry: ${source}`);
    }
  }
}

function builtinPointer(directory: string, keyVersion: string): PromptConfigPointer {
  return {
    version: 'builtin',
    cacheId: 'builtin',
    directory,
    storageMode: 'builtin',
    keyVersion,
  };
}

function createManifest(bundle: EncryptedPromptBundle, cacheId: string): StoredPromptManifest {
  return {
    version: bundle.version,
    cache_id: cacheId,
    storage_mode: 'encrypted',
    key_version: bundle.keyVersion,
    files: bundle.files.map((file) => {
      assertPromptRelativePath(file.path);
      return {
        path: file.path,
        envelope_path: `files/${file.path}.enc`,
        ciphertext_sha256: promptCiphertextDigest(file.ciphertext),
      };
    }),
  };
}

async function verifyStaging(directory: string, expected: StoredPromptManifest): Promise<void> {
  const manifest = await readStoredManifest(directory);
  if (
    manifest.version !== expected.version ||
    manifest.cache_id !== expected.cache_id ||
    manifest.key_version !== expected.key_version
  ) {
    throw new PromptConfigError(
      'PROMPT_STORAGE_INVALID',
      'Prompt manifest does not match the selected version',
    );
  }
  if (manifest.files.length !== expected.files.length) {
    throw new PromptConfigError('PROMPT_STORAGE_INVALID', 'Prompt manifest file count is invalid');
  }
  for (const expectedFile of expected.files) {
    await verifyStoredEnvelope(directory, manifest, expectedFile);
  }
}

async function readStoredManifest(directory: string): Promise<StoredPromptManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  } catch {
    throw new PromptConfigError('PROMPT_STORAGE_INVALID', 'Prompt manifest is unavailable');
  }
  const manifest = parseManifest(parsed);
  if (!manifest) {
    throw new PromptConfigError('PROMPT_STORAGE_INVALID', 'Prompt manifest is invalid');
  }
  return manifest;
}

async function verifyStoredEnvelope(
  directory: string,
  manifest: StoredPromptManifest,
  expected: StoredPromptManifest['files'][number],
): Promise<void> {
  const file = manifest.files.find((candidate) => candidate.path === expected.path);
  if (
    !file ||
    file.envelope_path !== expected.envelope_path ||
    file.ciphertext_sha256 !== expected.ciphertext_sha256
  ) {
    throw new PromptConfigError('PROMPT_STORAGE_INVALID', 'Prompt manifest file is invalid');
  }
  const envelope = await readStoredEnvelope(directory, file.envelope_path);
  if (
    envelope.version !== manifest.version ||
    envelope.path !== file.path ||
    envelope.algorithm !== 'AES-256-GCM' ||
    typeof envelope.ciphertext !== 'string' ||
    promptCiphertextDigest(envelope.ciphertext) !== file.ciphertext_sha256
  ) {
    throw new PromptConfigError('PROMPT_STORAGE_INVALID', 'Prompt envelope is invalid');
  }
}

async function readStoredEnvelope(
  directory: string,
  envelopePath: string,
): Promise<Record<string, unknown>> {
  try {
    const envelope: unknown = JSON.parse(
      await readFile(promptPathWithin(directory, envelopePath), 'utf8'),
    );
    if (isRecord(envelope)) return envelope;
  } catch {
    // Fall through to the stable storage error below.
  }
  throw new PromptConfigError('PROMPT_STORAGE_INVALID', 'Prompt envelope is unavailable');
}

function parsePointer(value: unknown): PromptConfigPointer | undefined {
  if (!isRecord(value)) return undefined;
  const mode = value.storage_mode;
  if (
    typeof value.version !== 'string' ||
    typeof value.cache_id !== 'string' ||
    typeof value.directory !== 'string' ||
    typeof value.key_version !== 'string' ||
    (mode !== 'builtin' && mode !== 'plaintext' && mode !== 'encrypted')
  ) {
    return undefined;
  }
  return {
    version: value.version,
    cacheId: value.cache_id,
    directory: value.directory,
    storageMode: mode,
    keyVersion: value.key_version,
    ...(typeof value.last_checked_at_ms === 'number'
      ? { lastCheckedAtMs: value.last_checked_at_ms }
      : {}),
  };
}

function parseManifest(value: unknown): StoredPromptManifest | undefined {
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
  const files = value.files.map((file) => {
    if (!isRecord(file)) return undefined;
    if (
      typeof file.path !== 'string' ||
      typeof file.envelope_path !== 'string' ||
      typeof file.ciphertext_sha256 !== 'string'
    ) {
      return undefined;
    }
    return {
      path: file.path,
      envelope_path: file.envelope_path,
      ciphertext_sha256: file.ciphertext_sha256,
    };
  });
  if (files.some((file) => !file)) return undefined;
  return {
    version: value.version,
    cache_id: value.cache_id,
    storage_mode: 'encrypted',
    key_version: value.key_version,
    files: files as StoredPromptManifest['files'],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const value = relative(resolve(root), target);
  return !!value && value !== '..' && !value.startsWith(`..${sep}`);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
