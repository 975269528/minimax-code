import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY = Buffer.from('9caab242102d2db9082a6e12508d4c2630546e8b9a7d55d67f95127bf4125a2b', 'hex');

/** Compatibility codec; imported ciphertext is copied without decoding. */
export function encryptIdentityField(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptIdentityField(encoded: string | null | undefined): string | null {
  if (encoded == null) return null;
  const parts = encoded.split(':');
  if (parts.length !== 3) return null;
  const ivEncoded = parts[0];
  const authTagEncoded = parts[1];
  const ciphertextEncoded = parts[2];
  if (ivEncoded === undefined || authTagEncoded === undefined || ciphertextEncoded === undefined) {
    return null;
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(ivEncoded, 'base64'), {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(Buffer.from(authTagEncoded, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextEncoded, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
