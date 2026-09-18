import {
  LocalPermissionRuleError,
  type LocalPermissionAction,
  type LocalPermissionBehavior,
  type LocalPermissionMatcher,
  type LocalPermissionRule,
  type LocalPermissionRuleSource,
  type LocalPermissionRuleValue,
} from './rule-model.js';

type PermissionUpdateType = 'addRules' | 'removeRules' | 'replaceRules';

interface PermissionFileConfigV1 {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

interface StoredPermissionRule {
  tool_name: string;
  matcher:
    | { kind: 'tool' }
    | { kind: 'command'; pattern: string }
    | { kind: 'path'; pattern: string; actions: LocalPermissionAction[] };
}

interface PermissionFileConfigV2 {
  version: 2;
  allow?: StoredPermissionRule[];
  deny?: StoredPermissionRule[];
  ask?: StoredPermissionRule[];
}

interface PermissionUpdateInput {
  type: PermissionUpdateType;
  source: LocalPermissionRuleSource;
  destination: string;
  rules: LocalPermissionRuleValue[];
  behavior: LocalPermissionBehavior;
}

const VALID_BEHAVIORS = new Set<LocalPermissionBehavior>(['allow', 'deny', 'ask']);
const VALID_SOURCES = new Set<LocalPermissionRuleSource>(['global', 'agent', 'session']);
const ALL_PERMISSION_ACTIONS = [
  'read',
  'write',
  'delete',
  'execute',
  'network',
] as const satisfies readonly LocalPermissionAction[];
const VALID_ACTIONS = new Set<LocalPermissionAction>(ALL_PERMISSION_ACTIONS);

export function serializeLocalPermissionRule(rule: LocalPermissionRule): Record<string, unknown> {
  return {
    source: rule.source,
    ruleBehavior: rule.ruleBehavior,
    ruleValue: rule.ruleValue,
    destination: rule.destination,
    toolName: rule.ruleValue.toolName,
    behavior: rule.ruleBehavior,
    ...(rule.ruleValue.ruleContent ? { ruleContent: rule.ruleValue.ruleContent } : {}),
    ...(rule.ruleValue.matcher ? { matcher: rule.ruleValue.matcher } : {}),
  };
}

export function readPermissionUpdate(raw: Record<string, unknown>): PermissionUpdateInput {
  const type = raw.type;
  if (type !== 'addRules' && type !== 'removeRules' && type !== 'replaceRules') {
    throw new LocalPermissionRuleError('Invalid permission update type');
  }
  const source = readRuleSource(raw.source);
  const destination = typeof raw.destination === 'string' ? raw.destination : undefined;
  if (!destination) throw new LocalPermissionRuleError('Missing permission update destination');
  const behavior = readRuleBehavior(raw.behavior);
  const rawRules = Array.isArray(raw.rules) ? raw.rules : undefined;
  if (!rawRules || rawRules.length === 0) {
    throw new LocalPermissionRuleError('Permission update requires at least one rule');
  }
  const rules = rawRules.map(readRuleValue);
  return { type, source, destination, rules, behavior };
}

export function readRuleSource(value: unknown): LocalPermissionRuleSource {
  if (typeof value === 'string' && VALID_SOURCES.has(value as LocalPermissionRuleSource)) {
    return value as LocalPermissionRuleSource;
  }
  throw new LocalPermissionRuleError(`Invalid permission rule source: ${String(value)}`);
}

function readRuleBehavior(value: unknown): LocalPermissionBehavior {
  if (typeof value === 'string' && VALID_BEHAVIORS.has(value as LocalPermissionBehavior)) {
    return value as LocalPermissionBehavior;
  }
  throw new LocalPermissionRuleError(`Invalid permission rule behavior: ${String(value)}`);
}

function readRuleValue(raw: unknown): LocalPermissionRuleValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LocalPermissionRuleError('Invalid permission rule');
  }
  const record = raw as Record<string, unknown>;
  const toolName = record.toolName ?? record.tool_name;
  const ruleContent = record.ruleContent ?? record.rule_content;
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new LocalPermissionRuleError('Permission rule requires tool_name');
  }
  if (ruleContent !== undefined && typeof ruleContent !== 'string') {
    throw new LocalPermissionRuleError('Permission rule_content must be a string');
  }
  const matcher =
    record.matcher === undefined
      ? inferLegacyMatcher(typeof ruleContent === 'string' ? ruleContent : undefined)
      : readStoredMatcher(record.matcher);
  return {
    toolName,
    ...(matcher.kind === 'tool' ? {} : { ruleContent: matcher.pattern }),
    matcher,
  };
}

export function readRuleStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function configV1ToRules(
  config: PermissionFileConfigV1,
  source: LocalPermissionRuleSource,
  destination: string,
): LocalPermissionRule[] {
  return [
    ...ruleStringsToRules(config.allow, source, destination, 'allow'),
    ...ruleStringsToRules(config.deny, source, destination, 'deny'),
    ...ruleStringsToRules(config.ask, source, destination, 'ask'),
  ];
}

export function configV2ToRules(
  config: Record<string, unknown>,
  source: LocalPermissionRuleSource,
  destination: string,
): LocalPermissionRule[] {
  return [
    ...storedRulesToRules(config.allow, source, destination, 'allow'),
    ...storedRulesToRules(config.deny, source, destination, 'deny'),
    ...storedRulesToRules(config.ask, source, destination, 'ask'),
  ];
}

function ruleStringsToRules(
  rules: string[] | undefined,
  source: LocalPermissionRuleSource,
  destination: string,
  behavior: LocalPermissionBehavior,
): LocalPermissionRule[] {
  return (rules ?? []).map((raw) => ({
    source,
    ruleBehavior: behavior,
    ruleValue: parseRuleString(raw),
    destination,
  }));
}

function parseRuleString(raw: string): LocalPermissionRuleValue {
  const openParen = raw.indexOf('(');
  if (openParen <= 0 || raw[openParen - 1] === '\\') {
    return { toolName: raw, matcher: { kind: 'tool' } };
  }
  const closeParen = raw.lastIndexOf(')');
  if (closeParen <= openParen) return { toolName: raw, matcher: { kind: 'tool' } };
  const toolName = raw.slice(0, openParen);
  const ruleContent = raw.slice(openParen + 1, closeParen);
  const matcher = inferLegacyMatcher(ruleContent || undefined);
  return {
    toolName,
    ...(matcher.kind === 'tool' ? {} : { ruleContent: matcher.pattern }),
    matcher,
  };
}

function serializeRuleValue(rule: LocalPermissionRuleValue): string {
  const matcher = rule.matcher ?? inferLegacyMatcher(rule.ruleContent);
  if (matcher.kind === 'tool') return rule.toolName;
  // v1 has no action field. An explicit v1 writer selection is a strict
  // storage rollback, so project structured path matchers back to their
  // legacy `tool(pattern)` representation and intentionally discard actions.
  // This restores the pre-v2 matcher semantics, where a path rule applied to
  // every action understood by that tool.
  return `${rule.toolName}(${matcher.pattern})`;
}

export function rulesToConfigV1(rules: LocalPermissionRule[]): PermissionFileConfigV1 {
  const config: Required<PermissionFileConfigV1> = { allow: [], deny: [], ask: [] };
  for (const rule of rules) config[rule.ruleBehavior].push(serializeRuleValue(rule.ruleValue));
  return config;
}

export function rulesToConfigV2(rules: LocalPermissionRule[]): PermissionFileConfigV2 {
  const config: PermissionFileConfigV2 & {
    allow: StoredPermissionRule[];
    deny: StoredPermissionRule[];
    ask: StoredPermissionRule[];
  } = { version: 2, allow: [], deny: [], ask: [] };
  for (const rule of rules) config[rule.ruleBehavior].push(ruleValueToStoredRule(rule.ruleValue));
  return config;
}

function storedRulesToRules(
  value: unknown,
  source: LocalPermissionRuleSource,
  destination: string,
  behavior: LocalPermissionBehavior,
): LocalPermissionRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new LocalPermissionRuleError(`PermissionConfigV2 ${behavior} rules must be an array.`);
  }
  return value.map((raw) => ({
    source,
    destination,
    ruleBehavior: behavior,
    ruleValue: readStoredRule(raw),
  }));
}

function readStoredRule(raw: unknown): LocalPermissionRuleValue {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LocalPermissionRuleError('Invalid PermissionConfigV2 rule.');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.tool_name !== 'string' || !record.tool_name.trim()) {
    throw new LocalPermissionRuleError('PermissionConfigV2 rule requires tool_name.');
  }
  const matcher = readStoredMatcher(record.matcher);
  return {
    toolName: record.tool_name,
    ...(matcher.kind === 'tool' ? {} : { ruleContent: matcher.pattern }),
    matcher,
  };
}

function readStoredMatcher(raw: unknown): LocalPermissionMatcher {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LocalPermissionRuleError('PermissionConfigV2 rule requires matcher.');
  }
  const record = raw as Record<string, unknown>;
  if (record.kind === 'tool') return { kind: 'tool' };
  if (record.kind === 'command') {
    if (typeof record.pattern !== 'string' || !record.pattern.trim()) {
      throw new LocalPermissionRuleError('Command matcher requires a non-empty pattern.');
    }
    return { kind: 'command', pattern: record.pattern };
  }
  if (record.kind === 'path') {
    if (typeof record.pattern !== 'string' || !record.pattern.trim()) {
      throw new LocalPermissionRuleError('Path matcher requires a non-empty pattern.');
    }
    if (!Array.isArray(record.actions) || record.actions.length === 0) {
      throw new LocalPermissionRuleError('Path matcher requires explicit actions.');
    }
    const actions = [...new Set(record.actions.map(readPermissionAction))];
    return { kind: 'path', pattern: record.pattern, actions };
  }
  throw new LocalPermissionRuleError(`Invalid permission matcher kind: ${String(record.kind)}`);
}

function readPermissionAction(value: unknown): LocalPermissionAction {
  if (typeof value === 'string' && VALID_ACTIONS.has(value as LocalPermissionAction)) {
    return value as LocalPermissionAction;
  }
  throw new LocalPermissionRuleError(`Invalid permission action: ${String(value)}`);
}

function inferLegacyMatcher(ruleContent: string | undefined): LocalPermissionMatcher {
  if (!ruleContent) return { kind: 'tool' };
  return looksLikePathPattern(ruleContent)
    ? { kind: 'path', pattern: ruleContent }
    : { kind: 'command', pattern: ruleContent };
}

function looksLikePathPattern(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\')
  );
}

function ruleValueToStoredRule(rule: LocalPermissionRuleValue): StoredPermissionRule {
  const matcher = rule.matcher ?? inferLegacyMatcher(rule.ruleContent);
  if (matcher.kind === 'tool') {
    return { tool_name: rule.toolName, matcher: { kind: 'tool' } };
  }
  if (matcher.kind === 'command') {
    return { tool_name: rule.toolName, matcher: { kind: 'command', pattern: matcher.pattern } };
  }
  return {
    tool_name: rule.toolName,
    matcher: {
      kind: 'path',
      pattern: matcher.pattern,
      actions: matcher.actions?.length ? [...matcher.actions] : [...ALL_PERMISSION_ACTIONS],
    },
  };
}

export function mutateRules(
  current: LocalPermissionRule[],
  update: PermissionUpdateInput,
): LocalPermissionRule[] {
  if (update.type === 'replaceRules') {
    return [
      ...current.filter((rule) => rule.ruleBehavior !== update.behavior),
      ...update.rules.map((ruleValue) => buildRule(update, ruleValue)),
    ];
  }
  if (update.type === 'removeRules') {
    return current.filter(
      (rule) =>
        rule.ruleBehavior !== update.behavior ||
        !update.rules.some((ruleValue) => ruleValuesEqual(rule.ruleValue, ruleValue)),
    );
  }
  const next = [...current];
  for (const ruleValue of update.rules) {
    if (
      next.some(
        (rule) =>
          rule.ruleBehavior === update.behavior && ruleValuesEqual(rule.ruleValue, ruleValue),
      )
    ) {
      continue;
    }
    next.push(buildRule(update, ruleValue));
  }
  return next;
}

function buildRule(update: PermissionUpdateInput, ruleValue: LocalPermissionRuleValue) {
  return {
    source: update.source,
    ruleBehavior: update.behavior,
    ruleValue,
    destination: update.destination,
  };
}

function ruleValuesEqual(a: LocalPermissionRuleValue, b: LocalPermissionRuleValue): boolean {
  if (a.toolName !== b.toolName) return false;
  const aMatcher = a.matcher ?? inferLegacyMatcher(a.ruleContent);
  const bMatcher = b.matcher ?? inferLegacyMatcher(b.ruleContent);
  if (aMatcher.kind !== bMatcher.kind) return false;
  if (aMatcher.kind === 'tool' || bMatcher.kind === 'tool') return true;
  if (aMatcher.pattern !== bMatcher.pattern) return false;
  if (aMatcher.kind === 'command' || bMatcher.kind === 'command') return true;
  return sameActions(aMatcher.actions, bMatcher.actions);
}

function sameActions(
  a: readonly LocalPermissionAction[] | undefined,
  b: readonly LocalPermissionAction[] | undefined,
): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((action) => b.includes(action));
}
