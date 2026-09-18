/**
 * Pure matching logic for local permission rules: given the persisted rules
 * and a tool call, pick the winning rule (deny > ask > allow). Extracted from
 * `rules.ts`, which owns storage; this module has no I/O.
 */
import path from 'node:path';

import type {
  LocalPermissionAction,
  LocalPermissionMatcher,
  LocalPermissionRuleValue,
} from './rules.js';

type MatchableLocalPermissionRule = {
  readonly ruleBehavior: 'allow' | 'deny' | 'ask';
  readonly ruleValue: LocalPermissionRuleValue;
};

const FS_UMBRELLA_TOOL_NAME = 'fs';
const FS_PERMISSION_TOOLS = new Set(['edit', 'write', 'read', 'glob', 'grep', 'list']);

export function selectMatchingRule<T extends MatchableLocalPermissionRule>(
  rules: readonly T[],
  toolName: string,
  input: Record<string, unknown>,
): T | undefined {
  const matches = rules.filter((rule) => ruleMatches(rule, toolName, input));
  return (
    matches.find((rule) => rule.ruleBehavior === 'deny') ??
    matches.find((rule) => rule.ruleBehavior === 'ask') ??
    matches.find((rule) => rule.ruleBehavior === 'allow')
  );
}

function ruleMatches(
  rule: MatchableLocalPermissionRule,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (!permissionToolMatches(rule.ruleValue.toolName, toolName)) return false;
  const matcher = rule.ruleValue.matcher;
  if (matcher) return structuredMatcherMatches(matcher, toolName, input);
  const content = rule.ruleValue.ruleContent;
  if (!content) return true;
  const target = permissionInputTarget(toolName, input);
  if (!target) return false;
  if (target === content) return true;
  if (matchesPathGlob(target, content)) return true;
  if (isPathLikeWildcard(content)) return false;
  if (content.endsWith(':*')) return matchesCommandPrefix(target, content.slice(0, -2));
  if (content.endsWith('*')) return matchesPlainWildcard(target, content.slice(0, -1), toolName);
  return target === content;
}

function structuredMatcherMatches(
  matcher: LocalPermissionMatcher,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (matcher.kind === 'tool') return true;
  const target = permissionInputTarget(toolName, input);
  if (!target) return false;
  if (matcher.kind === 'path') {
    const action = permissionInputAction(toolName);
    if (matcher.actions && (!action || !matcher.actions.includes(action))) return false;
    return target === matcher.pattern || matchesPathGlob(target, matcher.pattern);
  }
  if (target === matcher.pattern) return true;
  if (matcher.pattern.endsWith(':*')) {
    return matchesCommandPrefix(target, matcher.pattern.slice(0, -2));
  }
  if (matcher.pattern.endsWith('*')) {
    return matchesPlainWildcard(target, matcher.pattern.slice(0, -1), toolName);
  }
  return false;
}

function permissionInputAction(toolName: string): LocalPermissionAction | undefined {
  if (toolName === 'read' || toolName === 'glob' || toolName === 'grep' || toolName === 'list') {
    return 'read';
  }
  if (toolName === 'write' || toolName === 'edit' || toolName === 'apply_patch') return 'write';
  if (toolName === 'web_fetch' || toolName === 'web_search') return 'network';
  return undefined;
}

function permissionToolMatches(ruleToolName: string, toolName: string): boolean {
  return (
    ruleToolName === toolName ||
    (ruleToolName === FS_UMBRELLA_TOOL_NAME && FS_PERMISSION_TOOLS.has(toolName))
  );
}

function permissionInputTarget(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const direct = input.command ?? input.path ?? input.filePath ?? input.file_path ?? input.pattern;
  if (typeof direct === 'string') return direct;
  // URL field: extract host for matching against domain-level rules.
  if (typeof input.url === 'string') {
    try {
      return new URL(input.url).host;
    } catch {
      return input.url;
    }
  }
  if (toolName === 'bash' && typeof input.cmd === 'string') return input.cmd;
  return safeJsonStringify(input);
}

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isPathLikeWildcard(pattern: string): boolean {
  return pattern.includes('*') && (pattern.includes('/') || pattern.includes('\\'));
}

function matchesPathGlob(target: string, pattern: string): boolean {
  const globPattern = normalizeGlobPattern(pattern);
  if (globPattern.endsWith('/**/*')) {
    return isPathAtOrBelow(target, globPattern.slice(0, -5));
  }
  if (globPattern.endsWith('/**')) {
    return isPathAtOrBelow(target, globPattern.slice(0, -3));
  }
  if (globPattern.endsWith('/*') && !globPattern.endsWith('/**/*')) {
    const base = resolvePathForCompare(globPattern.slice(0, -2));
    const resolvedTarget = resolvePathForCompare(target);
    if (!resolvedTarget.startsWith(`${base}/`)) return false;
    return !resolvedTarget.slice(base.length + 1).includes('/');
  }
  return false;
}

function matchesCommandPrefix(target: string, prefix: string): boolean {
  if (!prefix) return false;
  const trimmed = target.trim();
  if (hasShellCommandSeparator(trimmed)) return false;
  if (trimmed === prefix) return true;
  const next = trimmed[prefix.length];
  return trimmed.startsWith(prefix) && typeof next === 'string' && /\s/.test(next);
}

function matchesPlainWildcard(target: string, prefix: string, toolName: string): boolean {
  const trimmed = toolName === 'bash' ? target.trim() : target;
  if (toolName === 'bash' && hasShellCommandSeparator(trimmed)) return false;
  return trimmed.startsWith(prefix);
}

function hasShellCommandSeparator(value: string): boolean {
  return /&&|\|\||[;&|<>`\n\r]|\$\(|\$\{?ifs(?:\b|[:}])/i.test(value);
}

function normalizeGlobPattern(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '') || '/';
}

function isPathAtOrBelow(target: string, base: string): boolean {
  const resolvedTarget = resolvePathForCompare(target);
  const resolvedBase = resolvePathForCompare(base);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(`${resolvedBase}/`);
}

function resolvePathForCompare(value: string): string {
  const resolved = path.resolve(value.replaceAll('\\', path.sep));
  const normalized = resolved.split(path.sep).join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
