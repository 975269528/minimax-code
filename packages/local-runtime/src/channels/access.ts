import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelOwnerStore } from './owner-store.js';
import type { LocalChannelContext } from './infra.js';

/**
 * Result of the inbound access check. Distinct from `LocalChannelInboundResult`
 * because the access layer is the only layer that needs to know about
 * dedup — the rest of the runner just sees `handled: true` and a flag.
 */
export type ChannelAccessDecision = 'allow' | 'deny' | 'dedup';

/**
 * Reason attached to a `deny` decision. Surfaced to the IM client as a private
 * `reply` so the sender can understand why the message was dropped without
 * leaking internal terminology.
 */
export type ChannelAccessDenyReason = 'non-p2p-blocked' | 'not-owner' | 'invalid-ctx';

export interface ChannelAccessCheckOptions {
  ownerStore?: LocalChannelOwnerStore;
  /**
   * Predicate deciding whether a platform requires the per-client owner gate.
   * The local-runtime default is `(p) => p !== 'wechat'` (WeChat iLink Bot is
   * p2p-only, so the gate is redundant and the existing p2p token suffices).
   */
  requiresOwnerGate?: (platform: ChannelPlatform) => boolean;
  /**
   * Dedup cache TTL in milliseconds. Replayed events with the same
   * `${platform}:${clientName}:${eventId}` key inside the window are dropped.
   * Default 5 minutes.
   */
  dedupTtlMs?: number;
  /**
   * Cap on the dedup cache. When the cache exceeds this size, the oldest 25%
   * of entries are evicted. Default 1000.
   */
  dedupMaxEntries?: number;
  /**
   * Skip the event-id dedup check/write. Used by the AC pipeline after it
   * already ran the scheme-level `dedup → access-control` preflight.
   */
  skipDedupCheck?: boolean;
  /**
   * Skip the non-p2p hard-block even when the platform requires the
   * owner gate. Set when {@link LocalAccessControlStore} is wired and
   * already evaluates the full policy — without this skip, a group
   * message that AC would have allowed would be rejected by the
   * legacy gate before AC's allow reaches the route layer.
   */
  skipGroupHardBlock?: boolean;
  /**
   * Skip the owner-store check entirely. Set when AC's own owner gate
   * (which fires inside `evaluate`) is the single source of truth
   * for ownership. Without this skip, an AC policy that allows a
   * non-owner sender would still be rejected by the legacy owner gate
   * for non-owner p2p DMs.
   */
  skipOwnerGate?: boolean;
}

const DEFAULT_DEDUP_TTL_MS = 5 * 60_000;
const DEFAULT_DEDUP_MAX_ENTRIES = 1000;
const DEDUP_EVICT_RATIO = 0.25;

/**
 * Inbound access control. Runs in this order (D3 + D2):
 *
 * 1. **Dedup** — if `eventId` is present, look up the composite key
 *    `${platform}:${clientName}:${eventId}` in `dedupCache`. A hit inside
 *    `dedupTtlMs` returns `'dedup'` (no work performed).
 * 2. **Group hard-block** — for platforms that require the owner gate, any
 *    non-p2p event returns `'deny'` *before* the owner check. This is the
 *    safe default: `@bot` mention in a group is a trigger, not an
 *    authorisation, and group allowlist support is deferred to Phase 5.
 * 3. **Owner gate** — if the platform requires it, ask the owner store to
 *    claim or compare. The owner store serialises per `clientName` so two
 *    concurrent first-DM events cannot both bootstrap ownership.
 * 4. **Allow** — for platforms that do not require the owner gate, the
 *    message passes through (e.g. WeChat iLink Bot is p2p-only).
 */
export async function checkChannelAccess(
  ctx: LocalChannelContext,
  eventId: string | undefined,
  dedupCache: Map<string, number>,
  options: ChannelAccessCheckOptions,
): Promise<ChannelAccessDecision> {
  if (!ctx.clientName || !ctx.senderId) {
    return 'deny';
  }

  // 1. Dedup — composite key avoids cross-platform / cross-bot id collisions
  //    (D3). `eventId` is optional, so a missing id simply skips dedup.
  if (eventId && !options.skipDedupCheck) {
    const dedupKey = buildDedupKey(ctx.platform, ctx.clientName, eventId);
    if (isDedupHit(dedupCache, dedupKey, options.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS)) {
      // Refresh the entry so repeated-but-allowed traffic does not evict the
      // legitimate key. The set-also-keeps-insertion-order Map semantics
      // implement the LRU.
      dedupCache.set(dedupKey, Date.now());
      return 'dedup';
    }
  }

  // 2 + 3. Group hard-block + owner gate.
  const requiresGate = options.requiresOwnerGate?.(ctx.platform) ?? false;
  if (requiresGate && !options.skipGroupHardBlock && !isP2pChat(ctx.chatType)) {
    return 'deny';
  }
  if (requiresGate && !options.skipOwnerGate) {
    if (!options.ownerStore) {
      // No owner store configured → fail closed. This matches the principle
      // that the gate must not silently disappear if a wiring step is missed.
      return 'deny';
    }
    const decision = await options.ownerStore.checkAndBootstrap(
      ctx.clientName,
      ctx.senderId,
      undefined,
    );
    if (decision === 'deny') return 'deny';
  }

  // 4. Record the event id for future dedup, *after* the owner check has
  //    succeeded. A denied event must not poison the dedup cache, otherwise
  //    a retried-but-now-owner event would be silently dropped.
  if (eventId && !options.skipDedupCheck) {
    const dedupKey = buildDedupKey(ctx.platform, ctx.clientName, eventId);
    dedupCache.set(dedupKey, Date.now());
    evictIfNeeded(dedupCache, options.dedupMaxEntries ?? DEFAULT_DEDUP_MAX_ENTRIES);
  }

  return 'allow';
}

function buildDedupKey(platform: string, clientName: string, eventId: string): string {
  return `${platform}:${clientName}:${eventId}`;
}

function isDedupHit(cache: Map<string, number>, key: string, ttlMs: number): boolean {
  const storedAt = cache.get(key);
  if (storedAt === undefined) return false;
  if (Date.now() - storedAt > ttlMs) {
    cache.delete(key);
    return false;
  }
  return true;
}

function evictIfNeeded(cache: Map<string, number>, maxEntries: number): void {
  if (cache.size <= maxEntries) return;
  const dropCount = Math.ceil(cache.size * DEDUP_EVICT_RATIO);
  let dropped = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    dropped += 1;
    if (dropped >= dropCount) break;
  }
}

export function isP2pChat(chatType: string | undefined): boolean {
  if (!chatType) return false;
  const normalized = chatType.trim().toLowerCase();
  return normalized === 'p2p' || normalized === 'private' || normalized === 'dm';
}
