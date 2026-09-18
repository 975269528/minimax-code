export const PROMPT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type PromptStorageMode = 'builtin' | 'plaintext' | 'encrypted';

/** Immutable directory selection for one model-call assembly. */
export interface PromptReadContext {
  readonly scopeId: string;
  readonly subject: string;
  readonly version: string;
  readonly cacheId: string;
  readonly directory: string;
  readonly storageMode: PromptStorageMode;
  readonly keyVersion: string;
}

export interface PromptConfigAuthSnapshot {
  /** Hash-safe local directory scope. It never contains the raw user id. */
  readonly scopeId: string;
  /** `realUserID` for logged-in users, `anonymous` otherwise. */
  readonly subject: string;
  readonly keyVersion: string;
  /** Present only for the lifetime of a logged-in request or read context. */
  readonly accessToken?: string;
  /** Changes whenever credentials or the active account changes. */
  readonly generation: number;
}

export interface PromptConfigAuthProvider {
  capture(): PromptConfigAuthSnapshot;
}

export interface PromptKeyProvider {
  resolve(snapshot: PromptConfigAuthSnapshot): Uint8Array;
}

export interface EncryptedPromptEnvelope {
  readonly version: string;
  readonly algorithm: 'AES-256-GCM';
  readonly path: string;
  readonly nonce: string;
  /** Base64url ciphertext with the 16-byte GCM tag appended. */
  readonly ciphertext: string;
}

export interface EncryptedPromptBundle {
  readonly version: string;
  readonly algorithm: 'AES-256-GCM';
  readonly keyVersion: string;
  readonly files: readonly EncryptedPromptEnvelope[];
}

export interface PromptConfigClient {
  fetch(input: {
    readonly auth: PromptConfigAuthSnapshot;
    readonly etag?: string;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'updated';
        readonly etag: string;
        readonly bundle: EncryptedPromptBundle;
        /** Original encrypted response body. It is safe to persist unchanged. */
        readonly rawPayload: string;
      }
    | { readonly kind: 'not_modified' }
    | { readonly kind: 'disabled' }
  >;
}

export interface PromptFileReader {
  /** Returns undefined only when an optional builtin/plaintext file is absent. */
  read(context: PromptReadContext, relativePath: string): Promise<string | undefined>;
}

export interface PromptConfigPointer {
  readonly version: string;
  readonly cacheId: string;
  readonly directory: string;
  readonly storageMode: PromptStorageMode;
  readonly keyVersion: string;
  readonly lastCheckedAtMs?: number;
}

export interface PromptConfigRefreshResult {
  readonly kind: 'updated' | 'not_modified' | 'disabled' | 'skipped' | 'failed' | 'stale';
}
