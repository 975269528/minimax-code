/**
 * Telegram inline-keyboard + callback_data codec for permission cards (MR-E1).
 *
 * Telegram's `callback_data` field is hard-capped at **64 UTF-8 bytes**, so
 * we use a single-letter prefix `p:` and a fixed `p:<requestId>:<decision>`
 * layout instead of JSON. Permission cards are the only interactive surface
 * this file covers in MR-E1; questionnaire keyboards land in a follow-up
 * Telegram-questionnaire MR and can extend this file with additional
 * prefixes (`q:` / `qo:`) without revisiting the permission encoding.
 *
 * The decision vocabulary mirrors {@link ChannelPermissionBehavior}:
 *   - `allow`  — one-shot grant
 *   - `deny`   — refuse and remember nothing
 *   - `always` — grant and persist the rule
 */

/** Telegram `callback_data` hard limit (64 UTF-8 bytes). */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export type TelegramInlineKeyboard = TelegramInlineKeyboardButton[][];

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboard;
}

export type TelegramPermissionDecision = 'allow' | 'deny' | 'always';

export interface TelegramPermissionCallback {
  requestId: string;
  decision: TelegramPermissionDecision;
}

// ---------------------------------------------------------------------------
// Permission keyboard
// ---------------------------------------------------------------------------

/**
 * Build the three-button permission keyboard (Allow / Deny / Always allow).
 * Returns `undefined` when the requestId is too long to fit in any of the
 * three callback_data slots — the caller falls back to a text-only card.
 *
 * Layout: Allow + Deny share the first row (two-button row reads well on
 * mobile); Always allow stands alone on the second row to deter the
 * destructive default.
 */
export function buildPermissionKeyboard(
  requestId: string,
): TelegramInlineKeyboardMarkup | undefined {
  const allow = encodePermissionCallback(requestId, 'allow');
  const deny = encodePermissionCallback(requestId, 'deny');
  const always = encodePermissionCallback(requestId, 'always');
  if (!allow || !deny || !always) return undefined;
  return {
    inline_keyboard: [
      [
        { text: 'Allow', callback_data: allow },
        { text: 'Deny', callback_data: deny },
      ],
      [{ text: 'Always allow', callback_data: always }],
    ],
  };
}

export function encodePermissionCallback(
  requestId: string,
  decision: TelegramPermissionDecision,
): string | null {
  return packCallback(['p', requestId, decision]);
}

/**
 * Decode a `callback_data` produced by {@link encodePermissionCallback}.
 * Returns `null` for non-permission callbacks (the dispatcher can try
 * other prefixes) or malformed payloads (unknown decision value).
 */
export function decodePermissionCallback(raw: string): TelegramPermissionCallback | null {
  const parts = raw.split(':');
  if (parts[0] !== 'p' || parts.length !== 3) return null;
  const [, requestId, decision] = parts;
  if (!requestId) return null;
  if (decision === 'allow' || decision === 'deny' || decision === 'always') {
    return { requestId, decision };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Join callback_data parts with `:` and verify the result fits in 64 UTF-8
 * bytes. Returns `null` when oversize so callers can degrade. Rejects parts
 * that contain `:` themselves to keep the layout unambiguously parseable.
 */
function packCallback(parts: string[]): string | null {
  for (const part of parts) {
    if (part.includes(':')) return null;
  }
  const joined = parts.join(':');
  if (utf8ByteLength(joined) > TELEGRAM_CALLBACK_DATA_MAX_BYTES) return null;
  return joined;
}

export function utf8ByteLength(value: string): number {
  // TextEncoder.encode() is the canonical UTF-8 byte length in Node 18+.
  return new TextEncoder().encode(value).length;
}
