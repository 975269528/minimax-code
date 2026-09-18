import { join } from 'node:path';

import {
  channelRoutingModeForStrategy,
  type ChannelPlatform,
  type ChannelRoutingMode,
  type SessionStrategy,
} from '@mavis/shared';

import { json, notFound, readJsonBody } from '../api/http-helpers.js';
import { mutateDurableYaml, readYamlDocument } from './durable-yaml.js';

export type { ChannelPlatform, ChannelRoutingMode, SessionStrategy } from '@mavis/shared';

export interface ChannelRouteMatch {
  chatType: string;
  chatId: string;
  senderId: string;
  clientName: string;
}

export interface ChannelRouteTarget {
  agentId: string;
  sessionStrategy: SessionStrategy;
  sessionTitle: string;
  exactOwnerName: string;
  ownerInstanceId?: string;
  projectKey: string;
  routingMode: ChannelRoutingMode;
  sessionId?: string;
  generation: number;
}

export interface ChannelRouteRule {
  id: string;
  platform: ChannelPlatform;
  match: ChannelRouteMatch;
  target: ChannelRouteTarget;
  enabled: boolean;
  priority: number;
  requireMention?: boolean;
  createdAt: number;
  updatedAt: number;
}

type ChannelRouteRuleUpdate = Partial<
  Omit<ChannelRouteRule, 'id' | 'createdAt' | 'updatedAt' | 'match' | 'target'>
> & {
  match?: Partial<ChannelRouteMatch>;
  target?: Partial<ChannelRouteTarget>;
};

type ChannelRouteDefaults = Record<ChannelPlatform, Omit<ChannelRouteTarget, 'sessionTitle'>>;

interface ChannelRouteConfig {
  schemaVersion: number;
  rules: ChannelRouteRule[];
  defaultRoute: ChannelRouteDefaults;
}

export interface ChannelRoutePreviewContext {
  platform: ChannelPlatform;
  chatType: string;
  chatId: string;
  senderId: string;
  clientName: string;
  hasMention: boolean;
}

const ROUTES_FILENAME = 'channel-routes.yaml';
const RULE_ID_REGEX = /^[a-z0-9-]+$/u;
const AGENT_ID_REGEX = /^[a-z0-9-]+$/u;
const VALID_PLATFORMS: ChannelPlatform[] = ['feishu', 'telegram', 'wechat'];
const VALID_STRATEGIES: SessionStrategy[] = [
  'root',
  'main',
  'per-sender',
  'per-chat',
  'shared-task',
  'pin',
];

export async function routeLocalChannelRouteApi(input: {
  dataDir: string;
  defaultAgentName: string;
  request: Request;
  method: string;
  parts: string[];
  url: URL;
  nowMs: () => number;
}): Promise<Response> {
  const store = await LocalChannelRouteStore.load(
    input.dataDir,
    input.defaultAgentName,
    input.nowMs,
  );
  const tail = input.parts.slice(1);

  if (input.method === 'GET' && tail.join('/') === 'status') {
    return json({
      bridges: {
        feishu: { enabled: false },
        telegram: { enabled: false },
        wechat: { enabled: false },
      },
      defaults: store.getDefaults(),
      ruleCount: store.getRules().length,
    });
  }

  if (input.method === 'GET' && tail.join('/') === 'rules') {
    const platform = input.url.searchParams.get('platform');
    if (platform && !isChannelPlatform(platform)) {
      return json(
        { error: `Invalid platform: "${platform}"`, errorCode: 'INVALID_PLATFORM' },
        { status: 400 },
      );
    }
    const rules = store.getRules(platform ?? undefined);
    return json({ rules, count: rules.length });
  }

  if (tail[0] === 'rules' && tail[1]) {
    const ruleId = tail[1];
    if (!isValidRuleId(ruleId)) {
      return json({ error: 'Invalid rule ID', errorCode: 'INVALID_RULE_ID' }, { status: 400 });
    }

    if (input.method === 'GET' && tail.length === 2) {
      const rule = store.getRule(ruleId);
      if (!rule) {
        return json(
          { error: `Route rule "${ruleId}" not found`, errorCode: 'RULE_NOT_FOUND' },
          { status: 404 },
        );
      }
      return json({ rule });
    }

    if (input.method === 'PUT' && tail.length === 2) {
      const body = await readJsonBody(input.request);
      const update = readRuleUpdate(body);
      const result = await store.updateRule(ruleId, update);
      if ('error' in result) return result.error;
      return json({ rule: result.rule });
    }

    if (input.method === 'DELETE' && tail.length === 2) {
      const deleted = await store.deleteRule(ruleId);
      if (!deleted) {
        return json(
          { error: `Route rule "${ruleId}" not found`, errorCode: 'RULE_NOT_FOUND' },
          { status: 404 },
        );
      }
      return json({ success: true });
    }
  }

  if (input.method === 'POST' && tail.join('/') === 'rules') {
    const body = await readJsonBody(input.request);
    const parsed = readCreateRule(body, input.nowMs());
    if ('error' in parsed) return parsed.error;
    const result = await store.addRule(parsed.rule);
    if ('error' in result) return result.error;
    return json({ rule: result.rule }, { status: 201 });
  }

  if (input.method === 'GET' && tail.join('/') === 'defaults') {
    return json({ defaults: store.getDefaults() });
  }

  if (input.method === 'PUT' && tail.join('/') === 'defaults') {
    const body = await readJsonBody(input.request);
    const result = await store.updateDefaults(body);
    if ('error' in result) return result.error;
    return json({ defaults: result.defaults });
  }

  if (input.method === 'POST' && tail.join('/') === 'resolve') {
    const body = await readJsonBody(input.request);
    const ctx = readPreviewContext(body);
    if ('error' in ctx) return ctx.error;
    const preview = store.resolvePreview(ctx.ctx);
    return json({
      result: {
        ruleId: preview.ruleId,
        agentId: preview.agentId,
        sessionStrategy: preview.sessionStrategy,
        sessionTitle: preview.sessionTitle,
        blocked: preview.blocked,
      },
    });
  }

  return notFound(`/channel-route/${tail.join('/')}`);
}

export class LocalChannelRouteStore {
  private constructor(
    private readonly filePath: string,
    private readonly defaultAgentName: string,
    private readonly nowMs: () => number,
    private config: ChannelRouteConfig,
  ) {}

  static async load(
    dataDir: string,
    defaultAgentName: string,
    nowMs: () => number,
  ): Promise<LocalChannelRouteStore> {
    const filePath = join(dataDir, ROUTES_FILENAME);
    let config = defaultConfig(defaultAgentName);
    const parsed = await readYamlDocument(filePath);
    if (Object.keys(parsed).length > 0) config = normalizeConfig(parsed, defaultAgentName, nowMs);
    const store = new LocalChannelRouteStore(filePath, defaultAgentName, nowMs, config);
    store.sortRules();
    return store;
  }

  getRules(platform?: string): ChannelRouteRule[] {
    const rules = platform
      ? this.config.rules.filter((rule) => rule.platform === platform)
      : this.config.rules;
    return [...rules];
  }

  getRule(ruleId: string): ChannelRouteRule | undefined {
    return this.config.rules.find((rule) => rule.id === ruleId);
  }

  getDefaults(): ChannelRouteDefaults {
    return this.config.defaultRoute;
  }

  /**
   * Idempotently enrich the original route file before Phase-2 inbound opens.
   * `resolveOwner` may return undefined for a target whose Agent no longer
   * exists (deterministic dead reference): that target is kept as-is so
   * startup never bricks on it; inbound answers it with a receipt instead.
   */
  async migrateToV2(
    resolveOwner: (requestRef: string) => Promise<
      | {
          exactOwnerName: string;
          ownerKind: 'builtin' | 'custom';
          ownerInstanceId?: string;
        }
      | undefined
    >,
    resolveProjectKey?: (input: {
      exactOwnerName: string;
      platform: ChannelPlatform;
      clientName: string;
      currentProjectKey: string;
    }) => string,
  ): Promise<void> {
    await this.mutate<void>(async (config) => {
      for (const platform of VALID_PLATFORMS) {
        const target = await migrateTarget(config.defaultRoute[platform], resolveOwner);
        if (!target) continue;
        config.defaultRoute[platform] = {
          ...target,
          projectKey:
            resolveProjectKey?.({
              exactOwnerName: target.exactOwnerName,
              platform,
              clientName: '*',
              currentProjectKey: target.projectKey,
            }) ?? target.projectKey,
        };
      }
      for (const rule of config.rules) {
        const target = await migrateTarget(rule.target, resolveOwner);
        if (!target) continue;
        rule.target = {
          ...target,
          projectKey:
            resolveProjectKey?.({
              exactOwnerName: target.exactOwnerName,
              platform: rule.platform,
              clientName: rule.match.clientName || '*',
              currentProjectKey: target.projectKey,
            }) ?? target.projectKey,
        };
      }
      assertSingleProjectPerRouteProfile(config);
      return { changed: true, value: undefined };
    });
  }

  async addRule(rule: ChannelRouteRule): Promise<{ rule: ChannelRouteRule } | { error: Response }> {
    return this.mutate<{ rule: ChannelRouteRule } | { error: Response }>((config) => {
      if (config.rules.some((candidate) => candidate.id === rule.id)) {
        return {
          changed: false,
          value: {
            error: json(
              {
                error: `Route rule with id '${rule.id}' already exists`,
                errorCode: 'RULE_ALREADY_EXISTS',
              },
              { status: 409 },
            ),
          },
        };
      }
      config.rules.push(rule);
      return { changed: true, value: { rule } };
    });
  }

  async updateRule(
    ruleId: string,
    update: ChannelRouteRuleUpdate,
  ): Promise<{ rule: ChannelRouteRule } | { error: Response }> {
    return this.mutate<{ rule: ChannelRouteRule } | { error: Response }>((config) => {
      const index = config.rules.findIndex((rule) => rule.id === ruleId);
      if (index === -1) {
        return {
          changed: false,
          value: {
            error: json(
              { error: `Route rule '${ruleId}' not found`, errorCode: 'RULE_NOT_FOUND' },
              { status: 404 },
            ),
          },
        };
      }
      const existing = config.rules[index]!;
      const updated: ChannelRouteRule = {
        ...existing,
        ...update,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: this.nowMs(),
        match: update.match ? { ...existing.match, ...update.match } : existing.match,
        target: update.target
          ? normalizeTarget({ ...existing.target, ...update.target })
          : existing.target,
      };
      const validationError = validateRule(updated);
      if (validationError) return { changed: false, value: { error: validationError } };
      config.rules[index] = updated;
      return { changed: true, value: { rule: updated } };
    });
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    return this.mutate<boolean>((config) => {
      const index = config.rules.findIndex((rule) => rule.id === ruleId);
      if (index === -1) return { changed: false, value: false };
      config.rules.splice(index, 1);
      return { changed: true, value: true };
    });
  }

  async updateDefaults(
    body: Record<string, unknown>,
  ): Promise<{ defaults: ChannelRouteDefaults } | { error: Response }> {
    return this.mutate<{ defaults: ChannelRouteDefaults } | { error: Response }>((config) => {
      const next: ChannelRouteDefaults = { ...config.defaultRoute };
      for (const platform of VALID_PLATFORMS) {
        const value = body[platform];
        if (value === undefined) continue;
        if (!value || typeof value !== 'object') {
          return {
            changed: false,
            value: {
              error: json(
                { error: `Invalid ${platform} default`, errorCode: 'INVALID_DEFAULTS' },
                { status: 400 },
              ),
            },
          };
        }
        const target = normalizeDefaultTarget(
          { ...next[platform], ...(value as Record<string, unknown>) },
          this.defaultAgentName,
        );
        const validationError = validateDefaultTarget(platform, target);
        if (validationError) return { changed: false, value: { error: validationError } };
        next[platform] = target;
      }
      config.defaultRoute = next;
      return { changed: true, value: { defaults: config.defaultRoute } };
    });
  }

  resolvePreview(ctx: ChannelRoutePreviewContext): {
    ruleId: string | null;
    agentId: string;
    sessionStrategy: string;
    sessionTitle: string;
    blocked: boolean;
    exactOwnerName: string;
    ownerInstanceId?: string;
    projectKey: string;
    routingMode: ChannelRoutingMode;
    sessionId?: string;
    generation: number;
  } {
    for (const rule of this.config.rules.filter(
      (candidate) => candidate.platform === ctx.platform && candidate.enabled,
    )) {
      const match = matchRule(rule, ctx);
      if (match === 'skip') continue;
      return {
        ruleId: rule.id,
        agentId: rule.target.agentId,
        sessionStrategy: rule.target.sessionStrategy,
        sessionTitle: match === 'block' ? '' : expandTemplate(rule.target.sessionTitle, ctx),
        blocked: match === 'block',
        exactOwnerName: rule.target.exactOwnerName,
        ...(rule.target.ownerInstanceId ? { ownerInstanceId: rule.target.ownerInstanceId } : {}),
        projectKey: rule.target.projectKey,
        routingMode: rule.target.routingMode,
        ...(rule.target.sessionId ? { sessionId: rule.target.sessionId } : {}),
        generation: rule.target.generation,
      };
    }

    const target = this.config.defaultRoute[ctx.platform];
    return {
      ruleId: null,
      agentId: target.agentId,
      sessionStrategy: target.sessionStrategy,
      sessionTitle: '',
      blocked: shouldBlockByMentionPolicy(ctx),
      exactOwnerName: target.exactOwnerName,
      ...(target.ownerInstanceId ? { ownerInstanceId: target.ownerInstanceId } : {}),
      projectKey: target.projectKey,
      routingMode: target.routingMode,
      ...(target.sessionId ? { sessionId: target.sessionId } : {}),
      generation: target.generation,
    };
  }

  /**
   * Rewrite the primary family's route state onto the canonical Agent (plan
   * §6.1): `rule.match.clientName`, `rule.target.agentId` and the per-platform
   * default target agentId. Routes owned by any other Agent are untouched.
   *
   * A rewritten rule that lands on a match key the canonical Agent already
   * owns is deduped when the two rules are otherwise identical, and reported as
   * a conflict when they differ — picking either one could silently change
   * which chats reach the surviving binding. `mode: 'inspect'` decides without
   * writing.
   */
  async rekeyPrimaryFamily(input: {
    from: { clientName: string; agentId: string };
    to: { clientName: string; agentId: string };
    mode: 'inspect' | 'apply';
  }): Promise<{ conflicts: string[]; moved: number; deduped: number }> {
    return this.mutate((config) => {
      const conflicts: string[] = [];
      const rewritten: ChannelRouteRule[] = [];
      const dropped = new Set<string>();
      const matchKey = (rule: ChannelRouteRule): string =>
        [
          rule.platform,
          rule.match.chatType,
          rule.match.chatId,
          rule.match.senderId,
          rule.match.clientName,
        ].join('|');
      const canonicalByMatch = new Map<string, ChannelRouteRule>();
      for (const rule of config.rules) {
        if (rule.target.agentId === input.to.agentId) canonicalByMatch.set(matchKey(rule), rule);
      }
      for (const rule of config.rules) {
        const ownsClient = rule.match.clientName === input.from.clientName;
        const ownsTarget = rule.target.agentId === input.from.agentId;
        if (!ownsClient && !ownsTarget) continue;
        const next: ChannelRouteRule = {
          ...rule,
          match: {
            ...rule.match,
            ...(ownsClient ? { clientName: input.to.clientName } : {}),
          },
          target: { ...rule.target, ...(ownsTarget ? { agentId: input.to.agentId } : {}) },
          updatedAt: this.nowMs(),
        };
        const collision = canonicalByMatch.get(matchKey(next));
        if (!collision) {
          rewritten.push(next);
          continue;
        }
        if (
          collision.target.agentId === next.target.agentId &&
          collision.target.sessionStrategy === next.target.sessionStrategy &&
          collision.target.sessionTitle === next.target.sessionTitle &&
          collision.enabled === next.enabled &&
          collision.priority === next.priority &&
          (collision.requireMention ?? false) === (next.requireMention ?? false)
        ) {
          dropped.add(rule.id);
          continue;
        }
        conflicts.push(`channel_route:${rule.id}`);
      }
      const defaultsToRewrite = VALID_PLATFORMS.filter(
        (platform) => config.defaultRoute[platform].agentId === input.from.agentId,
      );
      const result = {
        conflicts,
        moved: rewritten.length + defaultsToRewrite.length,
        deduped: dropped.size,
      };
      if (input.mode === 'inspect' || conflicts.length > 0) {
        return { changed: false, value: result };
      }
      const byId = new Map(rewritten.map((rule) => [rule.id, rule]));
      config.rules = config.rules
        .filter((rule) => !dropped.has(rule.id))
        .map((rule) => byId.get(rule.id) ?? rule);
      for (const platform of defaultsToRewrite) {
        config.defaultRoute[platform] = {
          ...config.defaultRoute[platform],
          agentId: input.to.agentId,
          exactOwnerName: input.to.agentId,
        };
      }
      return { changed: result.moved > 0 || result.deduped > 0, value: result };
    });
  }

  private sortRules(): void {
    this.config.rules.sort((a, b) => a.priority - b.priority);
  }

  private async mutate<T>(
    operation: (
      config: ChannelRouteConfig,
    ) => { changed: boolean; value: T } | Promise<{ changed: boolean; value: T }>,
  ): Promise<T> {
    return mutateDurableYaml(this.filePath, async (document) => {
      this.config = normalizeConfig(document, this.defaultAgentName, this.nowMs);
      this.sortRules();
      const result = await operation(this.config);
      if (result.changed) {
        this.config.schemaVersion = 2;
        this.sortRules();
        mergeConfigIntoDocument(document, this.config);
      }
      return result;
    });
  }
}

async function migrateTarget<
  T extends Omit<ChannelRouteTarget, 'sessionTitle'> | ChannelRouteTarget,
>(
  target: T,
  resolveOwner: (requestRef: string) => Promise<
    | {
        exactOwnerName: string;
        ownerKind: 'builtin' | 'custom';
        ownerInstanceId?: string;
      }
    | undefined
  >,
): Promise<T | undefined> {
  const owner = await resolveOwner(target.agentId);
  if (!owner) return undefined;
  return {
    ...target,
    exactOwnerName: owner.exactOwnerName,
    ...(owner.ownerKind === 'custom' && owner.ownerInstanceId
      ? { ownerInstanceId: owner.ownerInstanceId }
      : { ownerInstanceId: undefined }),
    projectKey: target.projectKey || 'default',
    routingMode: target.routingMode ?? channelRoutingModeForStrategy(target.sessionStrategy),
    generation: Math.max(1, target.generation),
  };
}

function assertSingleProjectPerRouteProfile(config: ChannelRouteConfig): void {
  const projects = new Map<string, string>();
  const visit = (key: string, projectKey: string) => {
    const existing = projects.get(key);
    if (existing !== undefined && existing !== projectKey) {
      throw Object.assign(new Error('One Channel route profile cannot target multiple Projects.'), {
        status: 409,
        code: 'CHANNEL_ROUTE_MULTI_PROJECT',
      });
    }
    projects.set(key, projectKey);
  };
  for (const platform of VALID_PLATFORMS) {
    const target = config.defaultRoute[platform];
    visit(`${target.exactOwnerName}|${platform}|*`, target.projectKey);
  }
  for (const rule of config.rules) {
    visit(
      `${rule.target.exactOwnerName}|${rule.platform}|${rule.match.clientName || '*'}`,
      rule.target.projectKey,
    );
  }
}

function defaultConfig(defaultAgentName: string): ChannelRouteConfig {
  const target = defaultTarget(defaultAgentName);
  return {
    schemaVersion: 2,
    rules: [],
    defaultRoute: {
      feishu: { ...target },
      telegram: { ...target },
      wechat: { ...target },
    },
  };
}

function defaultTarget(defaultAgentName: string): Omit<ChannelRouteTarget, 'sessionTitle'> {
  return {
    agentId: defaultAgentName,
    sessionStrategy: 'root',
    exactOwnerName: defaultAgentName,
    projectKey: 'default',
    routingMode: 'project-main',
    generation: 0,
  };
}

function normalizeConfig(
  value: unknown,
  defaultAgentName: string,
  nowMs: () => number,
): ChannelRouteConfig {
  if (!value || typeof value !== 'object') return defaultConfig(defaultAgentName);
  const raw = value as Record<string, unknown>;
  const base = defaultConfig(defaultAgentName);
  const rules = Array.isArray(raw.rules)
    ? raw.rules
        .map((rule) => normalizeRule(rule, nowMs()))
        .filter((rule): rule is ChannelRouteRule => rule !== undefined)
    : [];
  const defaults =
    raw.defaultRoute && typeof raw.defaultRoute === 'object'
      ? {
          ...base.defaultRoute,
          ...normalizeDefaults(raw.defaultRoute as Record<string, unknown>, defaultAgentName),
        }
      : base.defaultRoute;
  return {
    schemaVersion: readNumber(raw.schemaVersion) ?? 1,
    rules,
    defaultRoute: defaults,
  };
}

function normalizeDefaults(
  raw: Record<string, unknown>,
  defaultAgentName: string,
): Partial<ChannelRouteDefaults> {
  const defaults: Partial<ChannelRouteDefaults> = {};
  for (const platform of VALID_PLATFORMS) {
    const value = raw[platform];
    if (value && typeof value === 'object') {
      defaults[platform] = normalizeDefaultTarget(
        value as Record<string, unknown>,
        defaultAgentName,
      );
    }
  }
  return defaults;
}

function normalizeDefaultTarget(
  raw: Record<string, unknown>,
  defaultAgentName: string,
): Omit<ChannelRouteTarget, 'sessionTitle'> {
  const agentId = readString(raw.agentId) ?? defaultAgentName;
  const sessionStrategy = normalizeStrategy(readString(raw.sessionStrategy)) ?? 'root';
  return {
    agentId,
    sessionStrategy,
    exactOwnerName: readString(raw.exactOwnerName) ?? agentId,
    ...(readString(raw.ownerInstanceId)
      ? { ownerInstanceId: readString(raw.ownerInstanceId) }
      : {}),
    projectKey: normalizeProjectKey(readString(raw.projectKey)),
    routingMode:
      normalizeRoutingMode(readString(raw.routingMode)) ??
      channelRoutingModeForStrategy(sessionStrategy),
    ...(readString(raw.sessionId) ? { sessionId: readString(raw.sessionId) } : {}),
    generation: normalizeGeneration(raw.generation),
  };
}

function normalizeTarget(raw: Record<string, unknown>): ChannelRouteTarget {
  const agentId = readString(raw.agentId)?.trim() ?? '';
  const sessionStrategy = normalizeStrategy(readString(raw.sessionStrategy)) ?? 'per-chat';
  const ownerInstanceId = readString(raw.ownerInstanceId)?.trim();
  const sessionId = readString(raw.sessionId)?.trim();
  return {
    agentId,
    sessionStrategy,
    sessionTitle: readString(raw.sessionTitle) ?? '',
    exactOwnerName: readString(raw.exactOwnerName)?.trim() || agentId,
    ...(ownerInstanceId ? { ownerInstanceId } : {}),
    projectKey: normalizeProjectKey(readString(raw.projectKey)),
    routingMode:
      normalizeRoutingMode(readString(raw.routingMode)) ??
      channelRoutingModeForStrategy(sessionStrategy),
    ...(sessionId ? { sessionId } : {}),
    generation: normalizeGeneration(raw.generation),
  };
}

function mergeConfigIntoDocument(
  document: Record<string, unknown>,
  config: ChannelRouteConfig,
): void {
  const oldRules = Array.isArray(document.rules) ? document.rules : [];
  const oldRulesById = new Map<string, Record<string, unknown>>();
  for (const candidate of oldRules) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const raw = candidate as Record<string, unknown>;
    const id = readString(raw.id);
    if (id) oldRulesById.set(id, raw);
  }
  document.schemaVersion = 2;
  document.rules = config.rules.map((rule) => {
    const previous = oldRulesById.get(rule.id) ?? {};
    const previousMatch = asRecord(previous.match);
    const previousTarget = asRecord(previous.target);
    return {
      ...previous,
      ...rule,
      match: { ...previousMatch, ...rule.match },
      target: { ...previousTarget, ...rule.target },
    };
  });
  const previousDefaults = asRecord(document.defaultRoute);
  const defaultRoute: Record<string, unknown> = { ...previousDefaults };
  for (const platform of VALID_PLATFORMS) {
    defaultRoute[platform] = {
      ...asRecord(previousDefaults[platform]),
      ...config.defaultRoute[platform],
    };
  }
  document.defaultRoute = defaultRoute;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRule(value: unknown, nowMs: number): ChannelRouteRule | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const id = readString(raw.id);
  const platform = normalizePlatform(readString(raw.platform));
  const rawTarget =
    raw.target && typeof raw.target === 'object' ? (raw.target as Record<string, unknown>) : {};
  const agentId = readString(rawTarget.agentId);
  if (!id || !platform || !agentId) return undefined;
  const rule: ChannelRouteRule = {
    id,
    platform,
    match: normalizeMatch(raw.match),
    target: normalizeTarget({
      agentId,
      sessionStrategy: normalizeStrategy(readString(rawTarget.sessionStrategy)) ?? 'per-chat',
      sessionTitle: readString(rawTarget.sessionTitle) ?? '',
      ...rawTarget,
    }),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    priority: clampPriority(readNumber(raw.priority) ?? 50),
    ...(typeof raw.requireMention === 'boolean' ? { requireMention: raw.requireMention } : {}),
    createdAt: readTimestamp(raw.createdAt, nowMs),
    updatedAt: readTimestamp(raw.updatedAt, nowMs),
  };
  return validateRule(rule) ? undefined : rule;
}

function readCreateRule(
  body: Record<string, unknown>,
  nowMs: number,
): { rule: ChannelRouteRule } | { error: Response } {
  const id = readString(body.id);
  const platform = normalizePlatform(readString(body.platform));
  const rawTarget =
    body.target && typeof body.target === 'object'
      ? (body.target as Record<string, unknown>)
      : undefined;
  const agentId = rawTarget ? readString(rawTarget.agentId) : undefined;
  if (!id || !platform || !rawTarget || !agentId) {
    return {
      error: json(
        { error: 'Missing required fields: id, platform, target', errorCode: 'MISSING_FIELDS' },
        { status: 400 },
      ),
    };
  }
  const rule: ChannelRouteRule = {
    id,
    platform,
    match: normalizeMatch(body.match),
    target: normalizeTarget({
      agentId,
      sessionStrategy: normalizeStrategy(readString(rawTarget.sessionStrategy)) ?? 'per-chat',
      sessionTitle: readString(rawTarget.sessionTitle) ?? '',
      ...rawTarget,
    }),
    enabled: body.enabled !== false,
    priority: clampPriority(readNumber(body.priority) ?? 50),
    ...(typeof body.requireMention === 'boolean' ? { requireMention: body.requireMention } : {}),
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  const validationError = validateRule(rule);
  if (validationError) return { error: validationError };
  return { rule };
}

function readRuleUpdate(body: Record<string, unknown>): ChannelRouteRuleUpdate {
  const update: ChannelRouteRuleUpdate = {};
  const platform = normalizePlatform(readString(body.platform));
  if (platform) update.platform = platform;
  if (body.match && typeof body.match === 'object') update.match = readMatchUpdate(body.match);
  if (body.target && typeof body.target === 'object') {
    const rawTarget = body.target as Record<string, unknown>;
    const target: Partial<ChannelRouteTarget> = {};
    const agentId = readString(rawTarget.agentId);
    const sessionStrategy = normalizeStrategy(readString(rawTarget.sessionStrategy));
    const sessionTitle = readString(rawTarget.sessionTitle);
    if (agentId) target.agentId = agentId;
    if (sessionStrategy) target.sessionStrategy = sessionStrategy;
    if (sessionTitle !== undefined) target.sessionTitle = sessionTitle;
    const exactOwnerName = readString(rawTarget.exactOwnerName);
    const ownerInstanceId = readString(rawTarget.ownerInstanceId);
    const projectKey = readString(rawTarget.projectKey);
    const routingMode = normalizeRoutingMode(readString(rawTarget.routingMode));
    const sessionId = readString(rawTarget.sessionId);
    const generation = readNumber(rawTarget.generation);
    if (exactOwnerName) target.exactOwnerName = exactOwnerName;
    if (ownerInstanceId) target.ownerInstanceId = ownerInstanceId;
    if (projectKey) target.projectKey = normalizeProjectKey(projectKey);
    if (routingMode) target.routingMode = routingMode;
    if (sessionId) target.sessionId = sessionId;
    if (generation !== undefined) target.generation = Math.max(0, Math.trunc(generation));
    update.target = target;
  }
  if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
  if (typeof body.requireMention === 'boolean') update.requireMention = body.requireMention;
  const priority = readNumber(body.priority);
  if (priority !== undefined) update.priority = clampPriority(priority);
  return update;
}

function readMatchUpdate(value: unknown): Partial<ChannelRouteMatch> {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const match: Partial<ChannelRouteMatch> = {};
  if (typeof raw.chatType === 'string') match.chatType = raw.chatType;
  if (typeof raw.chatId === 'string') match.chatId = raw.chatId;
  if (typeof raw.senderId === 'string') match.senderId = raw.senderId;
  if (typeof raw.clientName === 'string') match.clientName = raw.clientName;
  return match;
}

function normalizeMatch(value: unknown): ChannelRouteMatch {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    chatType: readString(raw.chatType) ?? '*',
    chatId: readString(raw.chatId) ?? '',
    senderId: readString(raw.senderId) ?? '',
    clientName: readString(raw.clientName) ?? '',
  };
}

function readPreviewContext(
  body: Record<string, unknown>,
): { ctx: ChannelRoutePreviewContext } | { error: Response } {
  const platform = normalizePlatform(readString(body.platform));
  const chatType = readString(body.chatType);
  if (!platform || !chatType) {
    return {
      error: json(
        { error: 'Missing required fields: platform, chatType', errorCode: 'MISSING_FIELDS' },
        { status: 400 },
      ),
    };
  }
  return {
    ctx: {
      platform,
      chatType,
      chatId: readString(body.chatId) ?? '',
      senderId: readString(body.senderId) ?? '',
      clientName: readString(body.clientName) ?? '',
      hasMention: body.hasMention === true,
    },
  };
}

function validateRule(rule: ChannelRouteRule): Response | undefined {
  if (!isValidRuleId(rule.id)) {
    return json(
      { error: `Invalid rule id: "${rule.id}". Must be kebab-case`, errorCode: 'INVALID_RULE_ID' },
      { status: 400 },
    );
  }
  if (!isChannelPlatform(rule.platform)) {
    return json(
      { error: `Invalid platform: "${rule.platform}"`, errorCode: 'INVALID_PLATFORM' },
      { status: 400 },
    );
  }
  const defaultError = validateDefaultTarget(rule.platform, rule.target);
  if (defaultError) return defaultError;
  return undefined;
}

function validateDefaultTarget(
  platform: ChannelPlatform,
  target: { agentId: string; sessionStrategy: string },
): Response | undefined {
  if (!AGENT_ID_REGEX.test(target.agentId)) {
    return json(
      { error: `Invalid ${platform} agentId`, errorCode: 'INVALID_AGENT_ID' },
      { status: 400 },
    );
  }
  if (!isSessionStrategy(target.sessionStrategy)) {
    return json(
      { error: `Invalid ${platform} sessionStrategy`, errorCode: 'INVALID_STRATEGY' },
      { status: 400 },
    );
  }
  if (
    'projectKey' in target &&
    normalizeProjectKey(String(target.projectKey)) !== target.projectKey
  ) {
    return json(
      { error: `Invalid ${platform} projectKey`, errorCode: 'INVALID_PROJECT_KEY' },
      { status: 400 },
    );
  }
  return undefined;
}

function matchRule(
  rule: ChannelRouteRule,
  ctx: ChannelRoutePreviewContext,
): 'match' | 'skip' | 'block' {
  if (rule.match.clientName && rule.match.clientName !== ctx.clientName) return 'skip';
  if (rule.match.chatType !== '*' && rule.match.chatType !== ctx.chatType) return 'skip';
  if (rule.match.chatId && rule.match.chatId !== ctx.chatId) return 'skip';
  if (rule.match.senderId && rule.match.senderId !== ctx.senderId) return 'skip';
  return shouldBlockByMentionPolicy(ctx, rule.requireMention) ? 'block' : 'match';
}

function shouldBlockByMentionPolicy(
  ctx: ChannelRoutePreviewContext,
  requireMention?: boolean,
): boolean {
  const effective = requireMention ?? defaultRequireMention(ctx);
  return effective && !ctx.hasMention;
}

function defaultRequireMention(ctx: ChannelRoutePreviewContext): boolean {
  if (!['group', 'supergroup', 'channel'].includes(ctx.chatType)) return false;
  return true;
}

function expandTemplate(template: string, ctx: ChannelRoutePreviewContext): string {
  if (!template) return `${ctx.platform}-shared-${ctx.chatId}`;
  return template
    .replace(/\{platform\}/g, ctx.platform)
    .replace(/\{chatId\}/g, ctx.chatId)
    .replace(/\{senderId\}/g, ctx.senderId);
}

function readTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(9999, Math.trunc(value)));
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizePlatform(value: string | undefined): ChannelPlatform | undefined {
  return isChannelPlatform(value) ? value : undefined;
}

function normalizeStrategy(value: string | undefined): SessionStrategy | undefined {
  return isSessionStrategy(value) ? value : undefined;
}

function normalizeRoutingMode(value: string | undefined): ChannelRoutingMode | undefined {
  return value === 'project-main' ||
    value === 'per-sender' ||
    value === 'per-chat' ||
    value === 'shared-task'
    ? value
    : undefined;
}

function normalizeProjectKey(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === 'default' || normalized?.startsWith('workspace:') ? normalized : 'default';
}

function normalizeGeneration(value: unknown): number {
  const generation = readNumber(value);
  return generation === undefined ? 0 : Math.max(0, Math.trunc(generation));
}

function isChannelPlatform(value: unknown): value is ChannelPlatform {
  return typeof value === 'string' && VALID_PLATFORMS.includes(value as ChannelPlatform);
}

function isSessionStrategy(value: unknown): value is SessionStrategy {
  return typeof value === 'string' && VALID_STRATEGIES.includes(value as SessionStrategy);
}

function isValidRuleId(value: string): boolean {
  return RULE_ID_REGEX.test(value);
}
