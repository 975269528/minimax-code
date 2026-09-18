import type { ChannelPlatform } from './route-api.js';
import {
  LocalAccessControlStore,
  buildAccessControlKey,
  defaultAccessControl,
  type AccessControl,
  type AccessControlPatch,
} from './access-control-store.js';
import { json, notFound, readJsonBody } from '../api/http-helpers.js';

/**
 * CRUD surface for the per-Agent-Channel Access Control policy.
 *
 * Routes:
 *   GET    /channel-bridge/access-control                       → list
 *   GET    /channel-bridge/access-control/:platform/:clientName → read
 *   PUT    /channel-bridge/access-control/:platform/:clientName → upsert (partial)
 *   DELETE /channel-bridge/access-control/:platform/:clientName → reset to default
 *
 * The PUT body is a partial `AccessControl`: callers may update one
 * field at a time without re-sending the rest. Responses include the canonical `key` so the UI does not
 * have to recompose the platform/clientName pair, and never include
 * any token / secret fields (the policy itself does not carry
 * credentials, but we still spell that out for future field additions).
 *
 * Returns 503 when the runtime is wired without an AC store — that
 * matches the existing "feature not wired" envelope used elsewhere
 * in `routeLocalChannelBridgeInfraApi` (e.g. Feishu card-action).
 *
 * `parts` is the path tail after the API mount — caller passes
 * `parts = ['access-control', '<platform>', '<clientName>']` etc.
 * (The infra layer's `splitPath('/channel-bridge/access-control/...')`
 * strips the `channel-bridge` mount.)
 */
export async function routeLocalAccessControlApi(input: {
  request: Request;
  method: string;
  parts: string[];
  store?: LocalAccessControlStore;
}): Promise<Response | undefined> {
  if (input.parts[0] !== 'access-control') return undefined;
  if (!input.store) {
    return json(
      {
        ok: false,
        error: 'Access Control store is not wired in this runtime.',
        code: 'ACCESS_CONTROL_UNAVAILABLE',
        localRuntime: true,
      },
      { status: 503 },
    );
  }
  const platform = input.parts[1];
  const clientName = input.parts[2];
  if (input.method === 'GET' && !platform) {
    return handleList(input.store);
  }
  if (!platform || !clientName) {
    return json(
      { error: 'platform and clientName are required', code: 'VALIDATION_ERROR' },
      { status: 400 },
    );
  }
  const normalized = normalizePlatform(platform);
  if (!normalized) {
    return json(
      { error: `Unsupported platform: ${platform}`, code: 'INVALID_PLATFORM' },
      { status: 400 },
    );
  }
  const key = buildAccessControlKey(normalized, clientName);
  if (input.method === 'GET') {
    return handleGet(input.store, normalized, clientName, key);
  }
  if (input.method === 'PUT') {
    return handlePut(input, normalized, clientName, key);
  }
  if (input.method === 'DELETE') {
    return handleDelete(input.store, normalized, clientName, key);
  }
  return notFound(`/channel-bridge/access-control/${normalized}/${clientName}`);
}

async function handleList(store: LocalAccessControlStore): Promise<Response> {
  const records = await store.list();
  return json({
    policies: records.map((record) => ({
      key: record.key,
      policy: record.policy,
    })),
  });
}

async function handleGet(
  store: LocalAccessControlStore,
  platform: ChannelPlatform,
  clientName: string,
  key: string,
): Promise<Response> {
  const policy = await store.get(platform, clientName);
  return json({ key, policy });
}

async function handlePut(
  input: { request: Request; store?: LocalAccessControlStore },
  platform: ChannelPlatform,
  clientName: string,
  key: string,
): Promise<Response> {
  // Caller (routeLocalAccessControlApi) only invokes handlePut after
  // confirming `store` is defined, but the helper keeps the optional
  // shape so the type matches the dispatcher's narrowing.
  const store = input.store;
  if (!store) {
    return json(
      { ok: false, error: 'Access Control store missing', code: 'ACCESS_CONTROL_UNAVAILABLE' },
      { status: 503 },
    );
  }
  const body = await readJsonBody(input.request);
  const patch = readPolicyPatch(body);
  if ('error' in patch) return patch.error;
  try {
    const next = await store.set(platform, clientName, patch.patch);
    return json({ ok: true, key, policy: next });
  } catch (err) {
    return json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: 'ACCESS_CONTROL_INVALID',
      },
      { status: 400 },
    );
  }
}

async function handleDelete(
  store: LocalAccessControlStore,
  platform: ChannelPlatform,
  clientName: string,
  key: string,
): Promise<Response> {
  // Migration doc §Integration point 5 says "return to the default policy after DELETE".
  // The store's `delete` removes the persisted entry entirely; the
  // next `get` falls through to `defaultAccessControl()`. We mirror
  // that by explicitly returning the default policy in the response
  // so the UI can re-render without a follow-up GET round-trip.
  await store.delete(platform, clientName);
  const policy = defaultAccessControl();
  return json({
    ok: true,
    deleted: true,
    key,
    policy,
    note: 'Policy reset to defaults; persisted entry removed.',
  });
}

function readPolicyPatch(
  body: Record<string, unknown>,
): { patch: AccessControlPatch } | { error: Response } {
  const patch: AccessControlPatch = {};
  if ('allowedUsers' in body || 'allowed_users' in body) {
    const raw = body.allowedUsers ?? body.allowed_users;
    if (raw === 'ALL') patch.allowedUsers = 'ALL';
    else if (raw === 'OWNER') patch.allowedUsers = [];
    else if (Array.isArray(raw)) patch.allowedUsers = raw.filter(isString);
    else if (raw === null) patch.allowedUsers = [];
    else {
      return {
        error: json(
          {
            error: 'allowedUsers must be "ALL", an array of strings, or null',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        ),
      };
    }
  }
  if ('allowedGroups' in body || 'allowed_groups' in body) {
    const raw = body.allowedGroups ?? body.allowed_groups;
    if (raw === 'ALL') patch.allowedGroups = 'ALL';
    else if (Array.isArray(raw)) patch.allowedGroups = raw.filter(isString);
    else if (raw === null) patch.allowedGroups = [];
    else {
      return {
        error: json(
          {
            error: 'allowedGroups must be "ALL", an array of strings, or null',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        ),
      };
    }
  }
  if ('allowGroupChat' in body || 'allow_group_chat' in body) {
    const raw = body.allowGroupChat ?? body.allow_group_chat;
    if (typeof raw !== 'boolean') {
      return {
        error: json(
          { error: 'allowGroupChat must be a boolean', code: 'VALIDATION_ERROR' },
          { status: 400 },
        ),
      };
    }
    if (raw === false) patch.allowedGroups = [];
  }
  if ('ownerOnly' in body || 'owner_only' in body) {
    const raw = body.ownerOnly ?? body.owner_only;
    if (typeof raw !== 'boolean') {
      return {
        error: json(
          { error: 'ownerOnly must be a boolean', code: 'VALIDATION_ERROR' },
          { status: 400 },
        ),
      };
    }
    if (!('allowedUsers' in patch)) patch.allowedUsers = raw ? [] : 'ALL';
  }
  if ('groupMentionPolicy' in body || 'group_mention_policy' in body) {
    const raw = body.groupMentionPolicy ?? body.group_mention_policy;
    if (
      raw !== 'mentionOnly' &&
      raw !== 'always' &&
      raw !== 'disabled' &&
      raw !== 'mention_only' &&
      raw !== 'mention-only'
    ) {
      return {
        error: json(
          {
            error: 'groupMentionPolicy must be one of "mentionOnly", "always", "disabled"',
            code: 'VALIDATION_ERROR',
          },
          { status: 400 },
        ),
      };
    }
    // Normalise aliases before persisting so the YAML on disk always
    // uses the canonical form.
    if (raw === 'mention_only' || raw === 'mention-only') patch.groupMentionPolicy = 'mentionOnly';
    else if (raw === 'mentionOnly' || raw === 'always' || raw === 'disabled') {
      patch.groupMentionPolicy = raw;
    }
  }
  if ('respondToMentionAll' in body || 'respond_to_mention_all' in body) {
    const raw = body.respondToMentionAll ?? body.respond_to_mention_all;
    if (typeof raw !== 'boolean') {
      return {
        error: json(
          { error: 'respondToMentionAll must be a boolean', code: 'VALIDATION_ERROR' },
          { status: 400 },
        ),
      };
    }
    patch.respondToMentionAll = raw;
  }
  return { patch };
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePlatform(value: string | undefined): ChannelPlatform | undefined {
  return value === 'feishu' || value === 'telegram' || value === 'wechat'
    ? (value as ChannelPlatform)
    : undefined;
}

// Re-exported so the host wire layer can construct a default store
// against the configured dataDir without reaching into the store
// module directly.
export { LocalAccessControlStore, buildAccessControlKey, defaultAccessControl };
export type { AccessControl } from './access-control-store.js';
