import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import yaml from 'js-yaml';

import { imLogger } from '../common/im-logger.js';
import type { LocalRuntimeLogger } from '../common/logger.js';

import type { ChannelPlatform } from './route-api.js';
import type { LocalChannelContext } from './infra.js';
import {
  clonePolicy,
  defaultAccessControl,
  evaluatePolicy,
  isValidAccessControlKey,
  normalizePolicy,
  parseAccessControlKey,
  policySummary,
  type AccessControl,
  type AccessControlDecision,
  type AccessControlDecisionAndReason,
  type AccessControlDenyReason,
  type AccessControlPatch,
} from './access-control-policy.js';

/**
 * Owner-id resolver used by {@link LocalAccessControlStore.evaluate}.
 *
 * The owner equality check is the bridge layer's responsibility — the
 * bridge runs `ownerStore.checkAndBootstrap` before `evaluate` so a
 * fresh binding's first DM is bootstrapped into the owner record
 * rather than denied by an un-recorded owner. The store then calls
 * `resolveOwnerSenderId(clientName)` to look up the now-known owner.
 *
 * Returning `undefined` is treated identically to a senderId
 * mismatch: the gate denies with `owner_only` so a caller that forgot
 * to bootstrap still fails closed. (No more "no owner yet → allow"
 * branch — see the migration doc's owner bootstrap ordering
 * rationale.)
 */
export type ResolveOwnerSenderId = (
  clientName: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Per-Agent-Channel access control policy persisted to
 * `<dataDir>/access-control.yaml`.
 *
 * Each entry is keyed by `${platform}:${clientName}` (e.g.
 * `telegram:telegram:mavis`, `feishu:mavis:feishu`,
 * `wechat:wechat:mavis`) so a single agent keeps three independent
 * policies — one per platform — and unrelated agents do not collide.
 *
 * The policy drives three independent gates, evaluated top-to-bottom by
 * {@link LocalAccessControlStore.evaluate} (short-circuit on the first
 * deny):
 *
 *   1. `allowedGroups=[]` on a non-p2p chat → `group_chat_disabled`
 *   2. `allowedGroups` allowlist miss → `group_not_allowed`
 *   3. `groupMentionPolicy` gate → `mention_required`
 *   4. `allowedUsers` identity gate → `owner_only` / `user_not_allowed`
 *
 * Semantics:
 *   - The recorded owner is always allowed.
 *   - `allowedUsers: []` allows no extra sender beyond owner.
 *   - `allowedUsers: ALL` allows every sender.
 *   - `allowedUsers: [id...]` allows owner plus those sender ids.
 *   - `allowedGroups: []` closes group chat; `ALL` / `[id...]` opens
 *     group chat for all / selected groups.
 *   - `groupMentionPolicy` defaults to `'mentionOnly'`: opening group
 *     traffic still requires an explicit `@bot` mention.
 *
 * Source of truth: knowledge/proposals/dev-im-access-control-yaml-migration.md.
 */
export interface AccessControlEvaluateInput {
  ctx: LocalChannelContext;
  /**
   * Async resolver for the recorded owner of `ctx.clientName`.
   * Implementations should call `ownerStore.getOwner(ctx.clientName)`
   * (which is synchronous after first load) or a hook the bridge
   * passes after `checkAndBootstrap`. Defaults to a no-owner
   * resolver so unit tests can exercise the gate without a wired
   * owner store.
   */
  resolveOwnerSenderId?: ResolveOwnerSenderId;
}

export interface AccessControlRecord {
  key: string;
  policy: AccessControl;
}

interface AccessControlFile {
  schemaVersion: number;
  accessControl: Record<string, AccessControl>;
}

/**
 * Light-weight logger surface used by the store to emit
 * `decision=allow` / `decision=deny` audit lines. Mirrors the shape
 * of `LocalRuntimeApiHost`'s `matrixLogger` so production callers can
 * forward through the same channel without pulling in the full host
 * (the store is consumed from `LocalChannelBridgeInfra`, which already
 * needs this seam for owner-bootstrap decisions). Both methods are
 * required so the store can call them unconditionally — silent
 * callers should pass no-op functions rather than omit the field.
 */
export interface AccessControlAuditLogger {
  logInfo: (message: string, fields?: Record<string, unknown>) => void;
  logWarn: (message: string, fields?: Record<string, unknown>) => void;
}

export const ACCESS_CONTROL_LOG_TAG = '[access-control]';

/**
 * Build the YAML key for a `${platform}:${clientName}` policy entry.
 * Empty / missing parts return an empty string so callers can short-
 * circuit on it (the store treats an empty key as invalid and falls
 * back to the default policy for the read path; the write path throws).
 */
export function buildAccessControlKey(
  platform: ChannelPlatform | string,
  clientName: string,
): string {
  if (!platform || !clientName) return '';
  return `${platform}:${clientName}`;
}

/**
 * Defensive default applied when a `clientName` has no entry on disk
 * *or* the stored entry is partial / unparseable. Matches the
 * migration doc §"Default policy":
 *
 *   - `allowedUsers: []` → preserves dev's existing owner-only default.
 *   - `allowedGroups: []` → group traffic is closed by default; the
 *     operator must opt in explicitly with a list or `ALL`.
 *   - `groupMentionPolicy: 'mentionOnly'` → even with groups open an
 *     `@bot` mention is required.
 */
/**
 * Persistence + evaluation layer for the per-Agent-Channel
 * `AccessControl` policy. Mirrors `LocalChannelOwnerStore`: YAML on
 * disk under `<dataDir>/access-control.yaml`, lazy load on first
 * access, atomic rewrite on every `set` / `delete`.
 *
 * The store does NOT serialise per `clientName` for `set` / `delete`
 * (unlike the owner store): policy edits happen out-of-band from
 * inbound traffic, and a 100% loss-free reload is recoverable from
 * disk so a small race window is acceptable. `evaluate` is pure
 * apart from the owner-store side-effect (bootstrap) the caller
 * already paid for in `LocalChannelBridgeInfra.handleInbound`.
 */
export class LocalAccessControlStore {
  private loaded = false;
  private loadPromise: Promise<void> | undefined;
  private readonly policies = new Map<string, AccessControl>();

  private readonly logger: AccessControlAuditLogger;

  constructor(
    private readonly dataDir: () => string,
    private readonly nowMs: () => number,
    private readonly options: LocalAccessControlStoreOptions = {},
  ) {
    // Migration doc §6 (Audit / observability) hard-requires every
    // evaluate() call to emit an audit line. When the caller does not
    // inject a logger we bind the IM-subsystem engineering logger so the
    // production wire path always satisfies the spec even without
    // explicit host wiring. Tests that want a silent store still pass
    // `{ logInfo: () => {}, logWarn: () => {} }`.
    this.logger = options.logger ?? bindAccessControlAuditLogger(imLogger);
  }

  /**
   * Return the persisted policy for `${platform}:${clientName}` (a fresh
   * copy — callers cannot mutate the in-memory map). Falls back to
   * {@link defaultAccessControl} when nothing is on disk.
   */
  async get(platform: ChannelPlatform, clientName: string): Promise<AccessControl> {
    if (!isValidKey(platform, clientName)) {
      return defaultAccessControl();
    }
    await this.load();
    const stored = this.policies.get(buildAccessControlKey(platform, clientName));
    return clonePolicy(stored ?? defaultAccessControl());
  }

  /**
   * Upsert the policy. Empty `clientName` is rejected (no-op) to avoid
   * a silent global key. Unknown platforms are also rejected so a typo
   * (`Telegarm`) does not end up persisted under a misspelled key.
   */
  async set(
    platform: ChannelPlatform,
    clientName: string,
    patch: AccessControlPatch,
  ): Promise<AccessControl> {
    if (!isValidKey(platform, clientName)) {
      throw new Error(`Invalid access-control key: ${platform}:${clientName}`);
    }
    await this.load();
    const key = buildAccessControlKey(platform, clientName);
    const base = this.policies.get(key) ?? defaultAccessControl();
    const next = normalizePolicy({ ...base, ...patch });
    this.policies.set(key, next);
    await this.save();
    return clonePolicy(next);
  }

  async delete(platform: ChannelPlatform, clientName: string): Promise<boolean> {
    if (!isValidKey(platform, clientName)) return false;
    await this.load();
    const key = buildAccessControlKey(platform, clientName);
    const deleted = this.policies.delete(key);
    if (deleted) await this.save();
    return deleted;
  }

  async list(): Promise<AccessControlRecord[]> {
    await this.load();
    return [...this.policies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, policy]) => ({ key, policy: clonePolicy(policy) }));
  }

  /**
   * Initialise the default policy for `${platform}:${clientName}` if
   * (and only if) no entry already exists. Returns `true` when the
   * call actually wrote the default, `false` when an entry was
   * already present (the bind / restore path must NOT overwrite a
   * user-customised policy — that is the migration doc's explicit
   * "do not change user choices" invariant).
   *
   * Silently no-ops on invalid keys so a transient bot-name like
   * `undefined` cannot crash a bind path.
   */
  async ensureDefaultPolicy(platform: ChannelPlatform, clientName: string): Promise<boolean> {
    if (!isValidKey(platform, clientName)) return false;
    await this.load();
    const key = buildAccessControlKey(platform, clientName);
    if (this.policies.has(key)) return false;
    const policy = defaultAccessControl();
    this.policies.set(key, policy);
    await this.save();
    return true;
  }

  /**
   * Run the five gates against `ctx` + the owner resolver. Pure apart
   * from the owner lookup the caller supplies via
   * `resolveOwnerSenderId` — the bridge layer is expected to run
   * `ownerStore.checkAndBootstrap` before calling `evaluate`, so a
   * fresh binding's first DM is bootstrapped into the owner record
   * rather than denied by an un-recorded owner. When
   * owner-checking and no owner is recorded (the resolver returns
   * `undefined`), the gate denies with `owner_only` — same shape as a
   * senderId mismatch — so a caller that forgot to bootstrap fails
   * closed instead of accidentally admitting an un-owned sender.
   */
  async evaluate(input: AccessControlEvaluateInput): Promise<AccessControlDecisionAndReason> {
    const { ctx, resolveOwnerSenderId } = input;
    const policy = await this.get(ctx.platform, ctx.clientName);
    const ownerSenderId = resolveOwnerSenderId
      ? await Promise.resolve(resolveOwnerSenderId(ctx.clientName))
      : undefined;
    const result = evaluatePolicy(policy, ctx, ownerSenderId);
    if (result.decision === 'deny') {
      this.logDecision('deny', policy, ctx, result, ownerSenderId);
      return result;
    }
    this.logDecision('allow', policy, ctx, result, ownerSenderId);
    return result;
  }

  logDenyReply(input: {
    ctx: LocalChannelContext;
    key: string;
    reason: AccessControlDenyReason;
    status: 'sent' | 'suppressed' | 'unavailable' | 'error';
    error?: string;
  }): void {
    this.logger.logWarn(`${ACCESS_CONTROL_LOG_TAG} deny-reply`, {
      decision: 'deny',
      key: input.key,
      platform: input.ctx.platform,
      clientName: input.ctx.clientName,
      chatType: input.ctx.chatType,
      chatId: input.ctx.chatId,
      senderId: input.ctx.senderId,
      hasMention: input.ctx.hasMention === true,
      reason: `access-control:${input.reason}`,
      replyStatus: input.status,
      ...(input.error ? { error: input.error } : {}),
    });
  }

  private logDecision(
    decision: AccessControlDecision,
    policy: AccessControl,
    ctx: LocalChannelContext,
    result: AccessControlDecisionAndReason,
    ownerSenderId: string | undefined,
  ): void {
    const key = buildAccessControlKey(ctx.platform, ctx.clientName);
    const baseFields = {
      decision,
      key,
      platform: ctx.platform,
      clientName: ctx.clientName,
      chatType: ctx.chatType,
      chatId: ctx.chatId,
      senderId: ctx.senderId,
      hasMention: ctx.hasMention === true,
    };
    if (decision === 'deny') {
      const reason = result.reason ? `access-control:${result.reason}` : 'access-control';
      this.logger.logWarn(`${ACCESS_CONTROL_LOG_TAG} decision=deny`, {
        ...baseFields,
        reason,
        policy: policySummary(policy),
        ...(policy.allowedUsers !== 'ALL' ? { ownerSenderId: ownerSenderId ?? null } : {}),
      });
      return;
    }
    // allow path: surface which list matched so the audit line answers
    // "why was this allowed?" without leaking the actual allowlist.
    this.logger.logInfo(`${ACCESS_CONTROL_LOG_TAG} decision=allow`, {
      ...baseFields,
      groupMentionPolicy: policy.groupMentionPolicy,
      allowedUsersMode:
        policy.allowedUsers === 'ALL' ? 'ALL' : `list(${policy.allowedUsers.length})`,
      allowedGroupsMode:
        policy.allowedGroups === 'ALL' ? 'ALL' : `list(${policy.allowedGroups.length})`,
      ...(policy.allowedUsers !== 'ALL'
        ? {
            ownerSenderId: ownerSenderId ?? null,
          }
        : {}),
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadOnce();
    try {
      await this.loadPromise;
      this.loaded = true;
    } finally {
      this.loadPromise = undefined;
    }
  }

  private async loadOnce(): Promise<void> {
    const raw = await readFile(this.filePath, 'utf8').catch(() => undefined);
    if (!raw) return;
    try {
      const parsed = yaml.load(raw) as Partial<AccessControlFile> | null;
      const accessControl = parsed?.accessControl;
      if (!accessControl || typeof accessControl !== 'object') return;
      for (const [key, value] of Object.entries(accessControl)) {
        if (!value || typeof value !== 'object') continue;
        const policy = normalizePolicy(value as unknown as Record<string, unknown>);
        const split = parseAccessControlKey(key);
        if (!split) continue;
        this.policies.set(buildAccessControlKey(split.platform, split.clientName), policy);
      }
    } catch {
      // Corrupt YAML — start empty. The next `save()` will rewrite the file.
    }
  }

  private async save(): Promise<void> {
    const payload: AccessControlFile = {
      schemaVersion: 1,
      accessControl: Object.fromEntries(
        [...this.policies.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, policy]) => [key, policy]),
      ),
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, yaml.dump(payload, { lineWidth: 120, noRefs: true }), 'utf8');
  }

  private get filePath(): string {
    return join(this.dataDir(), 'access-control.yaml');
  }
}

export interface LocalAccessControlStoreOptions {
  /**
   * Audit logger. Receives one structured log line per `evaluate()`
   * call. `logInfo` is called for `decision=allow`, `logWarn` for
   * `decision=deny`. Both methods are optional on the interface for
   * back-compat, but the store always supplies a usable logger —
   * when omitted here the constructor falls back to a console-backed
   * default so migration-doc §6 ("every evaluate() call must emit
   * one audit line") is satisfied even without explicit host wiring.
   * Production hosts typically pass their own logger to keep AC audit
   * lines alongside other channel subsystem logs.
   */
  logger?: AccessControlAuditLogger;
}

const isValidKey = isValidAccessControlKey;

export { defaultAccessControl } from './access-control-policy.js';
export type {
  AccessControl,
  AccessControlDecision,
  AccessControlDecisionAndReason,
  AccessControlDenyReason,
  AccessControlPatch,
} from './access-control-policy.js';

/**
 * Adapter that lifts a plain {@link LocalRuntimeLogger} into the shape
 * {@link LocalAccessControlStore} expects. Used both by the store's
 * default construction path (where the caller doesn't inject a logger)
 * and by explicit host wiring in `host-channels.ts`, which passes the
 * IM-subsystem logger through so AC audit lines land in
 * `im-runtime-*.log` alongside every other IM signal.
 *
 * Kept as a named export (not an inline construction) so a unit test can
 * assert the adapter forwards `chatId` / `senderId` field maps intact.
 */
export function bindAccessControlAuditLogger(
  localLogger: LocalRuntimeLogger,
): AccessControlAuditLogger {
  return {
    logInfo: (message, fields = {}) => localLogger.info(fields, message),
    logWarn: (message, fields = {}) => localLogger.warn(fields, message),
  };
}
