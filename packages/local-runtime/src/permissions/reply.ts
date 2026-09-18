/**
 * `applyPermissionReply` — synthetic-reply application path used by the IM
 * permission bridge. When a Telegram inline-keyboard click is decoded as a
 * permission decision, the channel runner calls this function to settle the
 * matching pending permission request through the existing route flow,
 * without going through the HTTP `/permission/batch-reply` endpoint.
 *
 * The function is a thin wrapper around `replyLocalPermissionRequests`:
 * routes own the pending-request map, the rule-store update, and the waiter
 * settle; the bridge only translates `allow / deny / always` →
 * `allowOnce / allowAlways / deny` and delegates.
 *
 * Throws `LocalPermissionReplyError` when the request id is unknown or no
 * longer pending so the caller can log and skip.
 */

import {
  replyLocalPermissionRequests,
  type LocalPermissionRouteContext,
} from '../api/routes/permissions.js';
import type { ChannelPermissionBehavior } from '../channels/permission-bridge.js';
import type { LocalPermissionDecision } from '../api/host-helpers.js';

export class LocalPermissionReplyError extends Error {
  constructor(
    readonly code: 'NOT_PENDING' | 'INVALID_BEHAVIOR',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Map a channel-side decoded decision to the daemon's three-way reply
 * vocabulary. `always` becomes `allowAlways` (persisted as a global rule);
 * `allow` becomes `allowOnce` (session-scoped); `deny` is identity.
 */
export function permissionBehaviorToReply(
  behavior: ChannelPermissionBehavior,
): LocalPermissionDecision {
  switch (behavior) {
    case 'allow':
      return 'allowOnce';
    case 'always':
      return 'allowAlways';
    case 'deny':
      return 'deny';
    default: {
      throw new LocalPermissionReplyError(
        'INVALID_BEHAVIOR',
        `Unknown permission behavior: ${String(behavior)}`,
      );
    }
  }
}

export async function applyPermissionReply(
  ctx: LocalPermissionRouteContext,
  requestId: string,
  behavior: ChannelPermissionBehavior,
): Promise<{ processed: string[]; skipped: string[] }> {
  const decision = permissionBehaviorToReply(behavior);
  const result = await replyLocalPermissionRequests(ctx, [requestId], decision);
  if (result.processed.length === 0) {
    throw new LocalPermissionReplyError(
      'NOT_PENDING',
      `Permission request ${requestId} is not pending`,
    );
  }
  return result;
}

/**
 * Channel-runner-facing wrapper around {@link applyPermissionReply} that
 * treats the NOT_PENDING race (desktop UI settled the request before the IM
 * click landed) as an expected no-op instead of an error. The optional
 * `onNotPending` hook lets the host emit an observability event; every other
 * failure propagates so the runner's fail-quiet backstop logs it.
 */
export async function applyPermissionReplyFromChannel(
  ctx: LocalPermissionRouteContext,
  input: { requestId: string; behavior: ChannelPermissionBehavior },
  onNotPending?: () => void,
): Promise<void> {
  try {
    await applyPermissionReply(ctx, input.requestId, input.behavior);
  } catch (err) {
    if (err instanceof LocalPermissionReplyError && err.code === 'NOT_PENDING') {
      onNotPending?.();
      return;
    }
    throw err;
  }
}
