import { createDecipheriv, createHash } from 'node:crypto';

import type { EncryptedPromptEnvelope, PromptKeyProvider } from '../contracts.js';
import { PromptConfigError } from '../errors.js';

const GCM_TAG_BYTES = 16;
const NONCE_BYTES = 12;

export interface CreatePromptKeyProviderOptions {
  readonly desktopKey: Uint8Array;
  readonly keyVersion?: string;
}

export function createPromptKeyProvider(
  options: CreatePromptKeyProviderOptions,
): PromptKeyProvider {
  const desktopKey = Buffer.from(options.desktopKey);
  if (desktopKey.length !== 32) {
    throw new PromptConfigError('PROMPT_KEY_INVALID', 'Desktop Prompt config key must be 32 bytes');
  }
  const keyVersion = options.keyVersion ?? 'desktop-v1';
  return {
    resolve(snapshot) {
      if (snapshot.keyVersion !== keyVersion) {
        throw new PromptConfigError(
          'PROMPT_KEY_VERSION_UNSUPPORTED',
          'Desktop Prompt config key version is unsupported',
        );
      }
      return Buffer.from(desktopKey);
    },
  };
}

export function decryptPromptEnvelope(
  envelope: EncryptedPromptEnvelope,
  input: { readonly key: Uint8Array; readonly subject: string },
): string {
  if (envelope.algorithm !== 'AES-256-GCM') {
    throw new PromptConfigError(
      'PROMPT_ALGORITHM_INVALID',
      'Prompt encryption algorithm is unsupported',
    );
  }
  const nonce = decodeBase64Url(envelope.nonce, 'nonce');
  const ciphertext = decodeBase64Url(envelope.ciphertext, 'ciphertext');
  if (
    nonce.length !== NONCE_BYTES ||
    ciphertext.length < GCM_TAG_BYTES ||
    input.key.length !== 32
  ) {
    throw new PromptConfigError('PROMPT_ENVELOPE_INVALID', 'Prompt envelope is invalid');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.key, nonce, {
      authTagLength: GCM_TAG_BYTES,
    });
    decipher.setAAD(promptAad(envelope.version, input.subject, envelope.path));
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES));
    return Buffer.concat([
      decipher.update(ciphertext.subarray(0, -GCM_TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new PromptConfigError('PROMPT_DECRYPT_FAILED', 'Prompt envelope authentication failed');
  }
}

export function computePromptBundleVersion(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].sort(compareUtf8)) {
    hash.update(Buffer.from(path, 'utf8'));
    hash.update('\0');
    hash.update(Buffer.from(files.get(path) ?? '', 'utf8'));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function computePromptCacheId(bundle: EncryptedPromptBundleLike): string {
  const hash = createHash('sha256');
  hash.update(bundle.version, 'utf8');
  hash.update('\0');
  for (const file of [...bundle.files].sort((left, right) => compareUtf8(left.path, right.path))) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(file.nonce, 'utf8');
    hash.update('\0');
    hash.update(file.ciphertext, 'utf8');
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export interface EncryptedPromptBundleLike {
  readonly version: string;
  readonly files: readonly Pick<EncryptedPromptEnvelope, 'path' | 'nonce' | 'ciphertext'>[];
}

export function promptCiphertextDigest(ciphertext: string): string {
  return `sha256:${createHash('sha256').update(ciphertext, 'utf8').digest('hex')}`;
}

function promptAad(version: string, subject: string, path: string): Buffer {
  assertNoNul(version, 'version');
  assertNoNul(subject, 'subject');
  assertNoNul(path, 'path');
  return Buffer.from(JSON.stringify({ version, subject, path }), 'utf8');
}

function decodeBase64Url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new PromptConfigError('PROMPT_ENVELOPE_INVALID', `Prompt ${field} is invalid`);
  }
  return Buffer.from(value, 'base64url');
}

function assertNoNul(value: string, field: string): void {
  if (!value || value.includes('\0')) {
    throw new PromptConfigError('PROMPT_ENVELOPE_INVALID', `Prompt ${field} is invalid`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
