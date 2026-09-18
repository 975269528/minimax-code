import { randomBytes } from 'node:crypto';

import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
} from '../identity.js';

/**
 * Provider keys that can never be assigned to a user provider: they are
 * either reserved provider ids in model keys or config tree roots.
 */
export const RESERVED_PROVIDER_KEYS: ReadonlySet<string> = new Set([
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_ID,
  'provider',
  CUSTOM_PROVIDER_ID_PREFIX.slice(0, -1),
]);

const SIMPLE_ASCII_NAME = /^[A-Za-z0-9 _-]+$/;

export interface GenerateProviderKeyInput {
  displayName: string | undefined;
  existingKeys: Iterable<string>;
  /** Injectable random source (6 hex chars) for deterministic tests. */
  randomHex?: () => string;
}

/**
 * Generate an immutable provider key from a display name. ASCII-safe names
 * become lowercase kebab; anything else (e.g. Chinese) gets a random
 * `provider-<hex>` key — no transliteration. Conflicts with reserved keys or
 * existing keys get a `-2`/`-3`… suffix. The key is generated once at
 * creation time and never recomputed on rename.
 */
export function generateProviderKey(input: GenerateProviderKeyInput): string {
  const randomHex = input.randomHex ?? (() => randomBytes(3).toString('hex'));
  const base = slugify(input.displayName) ?? `provider-${randomHex()}`;
  const taken = new Set(input.existingKeys);
  if (!taken.has(base) && !RESERVED_PROVIDER_KEYS.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate) && !RESERVED_PROVIDER_KEYS.has(candidate)) return candidate;
  }
}

function slugify(displayName: string | undefined): string | undefined {
  const trimmed = displayName?.trim();
  if (!trimmed || !SIMPLE_ASCII_NAME.test(trimmed)) return undefined;
  const slug = trimmed
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}
