import { FileStore, type FileStoreOptions } from './file-store.js';
import type { CredentialStore } from './types.js';

export type CreateCredentialStoreOptions = FileStoreOptions;

export function createCredentialStore(options: CreateCredentialStoreOptions): CredentialStore {
  return new FileStore(options);
}
