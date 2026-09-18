/**
 * Desktop error-log encryption.
 *
 * Raw `event_log` must never appear as plaintext in an HTTP body. Encrypt each event's event_log
 * with AES-256-GCM into this wire format:
 *
 *     v1.<base64url(nonce)>.<base64url(ciphertext_and_tag)>
 *
 * Key management (design §2, Encryption rules):
 * - The login token is the only key material. Its length varies, so derive a fixed 32-byte key with
 *   HKDF-SHA256.
 * - Use constant {@link HKDF_SALT} as salt and the caller's `user_id` as info. Binding derivation
 *   to user_id prevents replaying a token under another user identity to decrypt the original
 *   user's logs.
 * - Generate a fresh random 12-byte nonce per event; never reuse it, as required by GCM.
 *
 * Associated data (AAD): Authenticate plaintext `event_type` and `occurred_at_ms` metadata with GCM
 * to detect tampering. Current requirements exclude `code_location` from AAD. Gateway must use the
 * same HKDF parameters and the exact {@link buildAssociatedData} encoding, or GCM authentication
 * fails.
 */

import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { DesktopErrorLog } from './types.js';

/** Wire-format version prefix; increment when KDF, encryption, or AAD rules change. */
export const EVENT_LOG_WIRE_VERSION = 'v1';

/** Fixed HKDF salt (design §2); must match Gateway exactly. */
export const HKDF_SALT = 'mcode-desktop-event-log-v1';

/** AES-256 derives a 32-byte key; GCM uses a 12-byte nonce. */
const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;

/**
 * Derive a user-scoped AES-256 key from the login token using HKDF-SHA256.
 *
 * @param token Login access token, the only key material.
 * @param userId Real user ID, used as HKDF info to scope the key.
 * @returns A 32-byte key buffer.
 */
export function deriveEventLogKey(token: string, userId: string): Buffer {
  // `hkdfSync` returns ArrayBuffer; convert to the Buffer required by the encryption API.
  const derived = hkdfSync(
    'sha256',
    Buffer.from(token, 'utf8'),
    Buffer.from(HKDF_SALT, 'utf8'),
    Buffer.from(userId, 'utf8'),
    AES_KEY_BYTES,
  );
  return Buffer.from(derived);
}

/**
 * Encode metadata that stays plaintext but must be authenticated into fixed bytes.
 *
 * Bind only `event_type` and `occurred_at_ms`, explicitly excluding `code_location`. Use JSON with
 * fixed key order so client and Gateway produce identical AAD bytes. Both fields are structured
 * low-risk values (an enum-like string and integer), so JSON encoding is unambiguous.
 */
export function buildAssociatedData(
  event: Pick<DesktopErrorLog, 'event_type' | 'occurred_at_ms'>,
): Buffer {
  return Buffer.from(
    JSON.stringify({ event_type: event.event_type, occurred_at_ms: event.occurred_at_ms }),
    'utf8',
  );
}

/**
 * Encrypt one raw `event_log` into the `v1.<nonce>.<ciphertext+tag>` wire format.
 *
 * @param plaintextLog Raw error text to protect.
 * @param params.token Login token used as HKDF key material.
 * @param params.userId Real user ID used as HKDF info.
 * @param params.event Supplies AAD fields (`event_type`, `occurred_at_ms`).
 */
export function encryptEventLog(
  plaintextLog: string,
  params: {
    token: string;
    userId: string;
    event: Pick<DesktopErrorLog, 'event_type' | 'occurred_at_ms'>;
  },
): string {
  const key = deriveEventLogKey(params.token, params.userId);
  // Generate a fresh random nonce per event; reusing a nonce under the same key breaks GCM security.
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(buildAssociatedData(params.event));
  const ciphertext = Buffer.concat([cipher.update(plaintextLog, 'utf8'), cipher.final()]);
  // Append the 16-byte GCM authentication tag for Gateway integrity verification.
  const ciphertextAndTag = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${EVENT_LOG_WIRE_VERSION}.${nonce.toString('base64url')}.${ciphertextAndTag.toString('base64url')}`;
}
