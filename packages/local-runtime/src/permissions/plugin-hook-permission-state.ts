import { createHash } from 'node:crypto';
import path from 'node:path';

import type { PermissionRule } from '@mavis/permission';

import {
  LocalPluginHookPermissionMutationError,
  PLUGIN_HOOK_PERMISSION_STORE_VERSION as STORE_VERSION,
  type LocalPluginHookPermissionMutationInput,
  type PersistedPluginHookPermissionState as PersistedPermissionState,
  type PluginHookPermissionRuleValue,
  type PluginHookPermissionScopeState as PermissionScopeState,
  type PluginHookPermissionUpdate,
  type PluginHookWorkspacePermissionScope as WorkspacePermissionScope,
} from './plugin-hook-permission-contracts.js';

const MAX_UPDATES_PER_REQUEST = 256;
const MAX_RULES_PER_BEHAVIOR = 4_096;
const MAX_DIRECTORIES_PER_SCOPE = 1_024;

export function validateRuntimeModes(input: LocalPluginHookPermissionMutationInput): void {
  for (const update of input.updates) {
    if (update.type !== 'setMode') continue;
    if (update.mode === 'plan') {
      throw new LocalPluginHookPermissionMutationError(
        'Plugin Hook setMode(plan) is not supported because MiniMax Plan mode has a separate Turn lifecycle.',
        'UNSUPPORTED_MODE',
      );
    }
  }
}

export interface MutablePersistedPermissionState {
  version: typeof STORE_VERSION;
  user: PermissionScopeState;
  projects: Record<string, WorkspacePermissionScope>;
  locals: Record<string, WorkspacePermissionScope>;
}

export function validateMutationInput(input: LocalPluginHookPermissionMutationInput): void {
  if (
    !input.sessionId.trim() ||
    !input.cwd.trim() ||
    !Array.isArray(input.updates) ||
    input.updates.length > MAX_UPDATES_PER_REQUEST ||
    input.updates.some((update) => !isValidPermissionUpdate(update))
  ) {
    throw new LocalPluginHookPermissionMutationError(
      'Plugin Hook permission update has invalid identity or exceeds the operation limit.',
      'INVALID_UPDATE',
    );
  }
}

function isValidPermissionUpdate(value: unknown): value is PluginHookPermissionUpdate {
  if (!isRecord(value) || !isPermissionDestination(value.destination)) return false;
  if (value.type === 'addRules' || value.type === 'replaceRules' || value.type === 'removeRules') {
    return (
      (value.behavior === 'allow' || value.behavior === 'deny' || value.behavior === 'ask') &&
      Array.isArray(value.rules) &&
      value.rules.length <= MAX_RULES_PER_BEHAVIOR &&
      value.rules.every(
        (rule) =>
          isRecord(rule) &&
          typeof rule.toolName === 'string' &&
          Boolean(rule.toolName.trim()) &&
          rule.toolName.length <= 1_024 &&
          (rule.ruleContent === undefined ||
            (typeof rule.ruleContent === 'string' && rule.ruleContent.length <= 64 * 1024)),
      )
    );
  }
  if (value.type === 'setMode') {
    return (
      value.mode === 'default' ||
      value.mode === 'auto' ||
      value.mode === 'acceptEdits' ||
      value.mode === 'dontAsk' ||
      value.mode === 'bypassPermissions' ||
      value.mode === 'plan'
    );
  }
  if (value.type === 'addDirectories' || value.type === 'removeDirectories') {
    return (
      Array.isArray(value.directories) &&
      value.directories.length <= MAX_DIRECTORIES_PER_SCOPE &&
      value.directories.every(
        (directory) =>
          typeof directory === 'string' &&
          Boolean(directory.trim()) &&
          !directory.includes('\u0000') &&
          directory.length <= 16_384,
      )
    );
  }
  return false;
}

function isPermissionDestination(value: unknown): boolean {
  return (
    value === 'session' ||
    value === 'localSettings' ||
    value === 'projectSettings' ||
    value === 'userSettings'
  );
}

export function applyUpdate(
  state: PermissionScopeState,
  update: PluginHookPermissionUpdate,
  workspace: string,
): PermissionScopeState {
  const next = cloneScope(state);
  if (
    update.type === 'addRules' ||
    update.type === 'replaceRules' ||
    update.type === 'removeRules'
  ) {
    const current = [...next.rules[update.behavior]];
    const rules = update.rules.map(cloneRule);
    const replacement =
      update.type === 'replaceRules'
        ? uniqueRules(rules)
        : update.type === 'addRules'
          ? uniqueRules([...current, ...rules])
          : current.filter((candidate) => !rules.some((rule) => sameRule(candidate, rule)));
    if (replacement.length > MAX_RULES_PER_BEHAVIOR) {
      throw new LocalPluginHookPermissionMutationError(
        'Plugin Hook permission rule limit exceeded.',
        'INVALID_UPDATE',
      );
    }
    next.rules[update.behavior] = replacement;
  } else if (update.type === 'setMode') {
    next.mode = update.mode as PermissionScopeState['mode'];
  } else if (update.type === 'addDirectories' || update.type === 'removeDirectories') {
    const directories = update.directories.map((directory) =>
      normalizeDirectory(directory, workspace),
    );
    next.directories =
      update.type === 'addDirectories'
        ? [...new Set([...next.directories, ...directories])]
        : next.directories.filter((directory) => !directories.includes(directory));
    if (next.directories.length > MAX_DIRECTORIES_PER_SCOPE) {
      throw new LocalPluginHookPermissionMutationError(
        'Plugin Hook permission directory limit exceeded.',
        'INVALID_UPDATE',
      );
    }
  } else {
    throw new LocalPluginHookPermissionMutationError(
      'Plugin Hook permission update type is invalid.',
      'INVALID_UPDATE',
    );
  }
  return freezeScope(next);
}

export function parsePersisted(value: unknown): MutablePersistedPermissionState {
  if (!isRecord(value)) return invalidStore();
  const version = value.version === undefined ? STORE_VERSION : value.version;
  if (version !== STORE_VERSION) return invalidStore();
  return {
    version: STORE_VERSION,
    user: parseScope(value.user ?? {}),
    projects: parseWorkspaceScopes(value.projects ?? {}),
    locals: parseWorkspaceScopes(value.locals ?? {}),
  };
}

function parseWorkspaceScopes(value: unknown): Record<string, WorkspacePermissionScope> {
  if (!isRecord(value)) return invalidStore();
  const result: Record<string, WorkspacePermissionScope> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/u.test(key) || !isRecord(entry) || typeof entry.workspace !== 'string') {
      return invalidStore();
    }
    const workspace = normalizeWorkspace(entry.workspace);
    if (workspaceKey(workspace) !== key) return invalidStore();
    result[key] = { workspace, state: parseScope(entry.state) };
  }
  return result;
}

function parseScope(value: unknown): PermissionScopeState {
  if (!isRecord(value)) return invalidStore();
  const rules = isRecord(value.rules) ? value.rules : {};
  const result: PermissionScopeState = {
    rules: {
      allow: parseRules(rules.allow ?? []),
      deny: parseRules(rules.deny ?? []),
      ask: parseRules(rules.ask ?? []),
    },
    directories: parseDirectories(value.directories ?? []),
    ...(value.mode !== undefined ? { mode: parseMode(value.mode) } : {}),
  };
  return freezeScope(result);
}

function parseRules(value: unknown): readonly PluginHookPermissionRuleValue[] {
  if (!Array.isArray(value) || value.length > MAX_RULES_PER_BEHAVIOR) return invalidStore();
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.toolName !== 'string' ||
      !entry.toolName.trim() ||
      entry.toolName.length > 1_024 ||
      (entry.ruleContent !== undefined &&
        (typeof entry.ruleContent !== 'string' || entry.ruleContent.length > 64 * 1024))
    ) {
      return invalidStore();
    }
    return {
      toolName: entry.toolName,
      ...(entry.ruleContent !== undefined ? { ruleContent: entry.ruleContent } : {}),
    };
  });
}

function parseDirectories(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_DIRECTORIES_PER_SCOPE ||
    value.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry))
  ) {
    return invalidStore();
  }
  return [...new Set(value)];
}

function parseMode(value: unknown): PermissionScopeState['mode'] {
  if (value === 'default' || value === 'auto' || value === 'acceptEdits' || value === 'dontAsk') {
    return value;
  }
  return invalidStore();
}

export function toPermissionRules(
  state: PermissionScopeState,
  source: PermissionRule['source'],
): PermissionRule[] {
  return (['allow', 'deny', 'ask'] as const).flatMap((behavior) =>
    state.rules[behavior].map((rule) => ({
      source,
      ruleBehavior: behavior,
      ruleValue: cloneRule(rule),
    })),
  );
}

export function matchingWorkspaceState(
  entry: WorkspacePermissionScope | undefined,
  workspace: string,
): PermissionScopeState | undefined {
  if (!entry) return undefined;
  if (entry.workspace !== workspace) return invalidStore();
  return entry.state;
}

export function emptyPersisted(): MutablePersistedPermissionState {
  return { version: STORE_VERSION, user: emptyScope(), projects: {}, locals: {} };
}

export function emptyScope(): PermissionScopeState {
  return { rules: { allow: [], deny: [], ask: [] }, directories: [] };
}

export function clonePersisted(value: PersistedPermissionState): MutablePersistedPermissionState {
  return {
    version: STORE_VERSION,
    user: cloneScope(value.user),
    projects: Object.fromEntries(
      Object.entries(value.projects).map(([key, entry]) => [
        key,
        { workspace: entry.workspace, state: cloneScope(entry.state) },
      ]),
    ),
    locals: Object.fromEntries(
      Object.entries(value.locals).map(([key, entry]) => [
        key,
        { workspace: entry.workspace, state: cloneScope(entry.state) },
      ]),
    ),
  };
}

export function cloneScope(value: PermissionScopeState): {
  rules: Record<'allow' | 'deny' | 'ask', PluginHookPermissionRuleValue[]>;
  directories: string[];
  mode?: PermissionScopeState['mode'];
} {
  return {
    rules: {
      allow: value.rules.allow.map(cloneRule),
      deny: value.rules.deny.map(cloneRule),
      ask: value.rules.ask.map(cloneRule),
    },
    directories: [...value.directories],
    ...(value.mode ? { mode: value.mode } : {}),
  };
}

export function freezeScope(value: PermissionScopeState): PermissionScopeState {
  return {
    rules: {
      allow: Object.freeze(value.rules.allow.map(cloneRule)),
      deny: Object.freeze(value.rules.deny.map(cloneRule)),
      ask: Object.freeze(value.rules.ask.map(cloneRule)),
    },
    directories: Object.freeze([...value.directories]),
    ...(value.mode ? { mode: value.mode } : {}),
  };
}

function cloneRule(value: PluginHookPermissionRuleValue): PluginHookPermissionRuleValue {
  return {
    toolName: value.toolName,
    ...(value.ruleContent !== undefined ? { ruleContent: value.ruleContent } : {}),
  };
}

function uniqueRules(
  values: readonly PluginHookPermissionRuleValue[],
): PluginHookPermissionRuleValue[] {
  const result: PluginHookPermissionRuleValue[] = [];
  for (const value of values)
    if (!result.some((candidate) => sameRule(candidate, value))) result.push(value);
  return result;
}

function sameRule(
  left: PluginHookPermissionRuleValue,
  right: PluginHookPermissionRuleValue,
): boolean {
  return left.toolName === right.toolName && left.ruleContent === right.ruleContent;
}

export function normalizeWorkspace(value: string): string {
  return path.resolve(value);
}

function normalizeDirectory(value: string, workspace: string): string {
  if (!value.trim() || value.includes('\u0000')) {
    throw new LocalPluginHookPermissionMutationError(
      'Plugin Hook permission directory is invalid.',
      'INVALID_UPDATE',
    );
  }
  return path.resolve(workspace, value);
}

export function workspaceKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidStore(): never {
  throw new LocalPluginHookPermissionMutationError(
    'Plugin Hook permission store contains an unsupported or malformed value.',
    'STORE_CORRUPT',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
