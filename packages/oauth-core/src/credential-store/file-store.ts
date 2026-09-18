import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { atomicWritePrivateFile, ensurePrivateDirectory } from '../fs/atomic-write.js';
import {
  type CredentialKey,
  CredentialRecordCorruptError,
  type CredentialStore,
  CredentialStorePermissionError,
  parseStoredCredential,
  type StoredCredential,
} from './types.js';

const FILE_SCHEMA_VERSION = 1;

interface CredentialFilePayload {
  schemaVersion: 1;
  records: Record<string, StoredCredential>;
}

export interface FileStoreOptions {
  authHome: string;
}

function recordKey(key: CredentialKey): string {
  return `${key.service}\0${key.account}`;
}

function parsePayload(value: unknown): CredentialFilePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CredentialRecordCorruptError();
  }
  const payload = value as Record<string, unknown>;
  if (
    payload.schemaVersion !== FILE_SCHEMA_VERSION ||
    typeof payload.records !== 'object' ||
    payload.records === null ||
    Array.isArray(payload.records)
  ) {
    throw new CredentialRecordCorruptError();
  }
  const records = Object.fromEntries(
    Object.entries(payload.records).map(([key, credential]) => [
      key,
      parseStoredCredential(credential),
    ]),
  );
  return { schemaVersion: FILE_SCHEMA_VERSION, records };
}

export class FileStore implements CredentialStore {
  readonly kind = 'file' as const;

  private readonly authHome: string;
  private readonly path: string;

  constructor(options: FileStoreOptions) {
    this.authHome = options.authHome;
    this.path = join(options.authHome, 'auth.json');
  }

  async get(key: CredentialKey): Promise<StoredCredential | null> {
    const payload = await this.readPayload();
    return payload.records[recordKey(key)] ?? null;
  }

  async put(key: CredentialKey, credential: StoredCredential): Promise<void> {
    const payload = await this.readPayload();
    payload.records[recordKey(key)] = parseStoredCredential(credential);
    await this.writePayload(payload);
  }

  async delete(key: CredentialKey): Promise<void> {
    const payload = await this.readPayload();
    delete payload.records[recordKey(key)];
    await this.writePayload(payload);
  }

  async healthCheck(): Promise<void> {
    await ensurePrivateDirectory(this.authHome);
    await this.assertPrivatePermissions();
  }

  private async readPayload(): Promise<CredentialFilePayload> {
    let raw: string;
    try {
      await this.assertPrivatePermissions();
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: FILE_SCHEMA_VERSION, records: {} };
      }
      throw error;
    }

    try {
      return parsePayload(JSON.parse(raw));
    } catch (error) {
      if (error instanceof CredentialRecordCorruptError) throw error;
      throw new CredentialRecordCorruptError();
    }
  }

  private async assertPrivatePermissions(): Promise<void> {
    if (process.platform === 'win32') return;
    try {
      const [directory, file] = await Promise.all([stat(this.authHome), stat(this.path)]);
      if ((directory.mode & 0o077) !== 0 || (file.mode & 0o077) !== 0) {
        throw new CredentialStorePermissionError();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async writePayload(payload: CredentialFilePayload): Promise<void> {
    const validated = parsePayload(payload);
    await atomicWritePrivateFile(this.path, `${JSON.stringify(validated, null, 2)}\n`);
  }
}
