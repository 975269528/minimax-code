/**
 * Shared write-entrypoint seam for the primary Agent family (plan §5.2).
 *
 * Every path that can persist a platform credential — Desktop bind API, the
 * Feishu / Telegram / WeChat adapters, the legacy IM migration, startup
 * restore, and direct store calls from tests — goes through one of the three
 * `Local*ChannelStore.bind()` / `.unbind()` methods. Fixing only the UI bind
 * would leave the other four paths able to persist a second enabled record for
 * the same canonical family, so the stores share this one optional hook and the
 * primary-family reconciler is its only production implementation.
 *
 * The hook has two members because the two decisions happen on opposite sides
 * of the store's `save()`:
 *   - `isPrimaryFamilyAgent` runs BEFORE persisting so a primary-family bind is
 *     staged as `enabled=false`; a candidate must never be enabled on disk
 *     before the reconciler picked a winner.
 *   - `afterMutation` runs AFTER persisting, inside the reconciler's per
 *     `canonical family + platform` lock, and is what converges the family.
 *
 * Both members are always driven together by the same hook object, so the three
 * stores never carry their own copy of the family rules.
 */
export type ChannelFamilyMutationKind = 'bind' | 'unbind';

/** Snapshot captured before a store removes one primary-family credential. */
export interface ChannelFamilyUnbindSnapshot {
  readonly enabled: boolean;
  /** Stable platform identity; absent identities are never safe to auto-delete. */
  readonly identity?: string;
}

export interface ChannelFamilyMutationHook {
  /**
   * True when `agentName` belongs to the trusted primary Agent family
   * (canonical or a legacy compatible name). An untrusted primary bind rejects
   * before persistence; an exact unbind remains an ordinary exact removal.
   */
  isPrimaryFamilyAgent(agentName: string, kind?: ChannelFamilyMutationKind): Promise<boolean>;
  /**
   * Converge the family after the store persisted. Rejects when the mutation
   * could not produce a single active canonical winner — a primary-family bind
   * must fail rather than silently leave the caller with a disabled record.
   */
  afterMutation(input: {
    agentName: string;
    kind: ChannelFamilyMutationKind;
    /** Present only for an explicit store unbind, never logged. */
    unbound?: ChannelFamilyUnbindSnapshot;
  }): Promise<void>;
}
