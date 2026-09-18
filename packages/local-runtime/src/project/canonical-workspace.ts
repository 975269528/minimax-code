import path from 'node:path';

import { LEGACY_DATA_DIR_BASENAME, NEW_DATA_DIR_BASENAME } from '@mavis/config/data-dir';

import type { LocalSessionRecord } from '../sessions/controller.js';
import { validateAgentName } from '../agent/contract.js';

export const DEFAULT_PROJECT_KEY = 'default';

export function canonicalProjectWorkspaceDir(
  workspaceDir: string | undefined,
  runLocation?: LocalSessionRecord['runLocation'],
): string | undefined {
  const parentRepoDir = normalizeAbsolutePath(runLocation?.parentRepoDir);
  if (parentRepoDir) return collapseWorktreeDir(parentRepoDir);
  const normalizedWorkspace = normalizeAbsolutePath(workspaceDir);
  return normalizedWorkspace ? collapseWorktreeDir(normalizedWorkspace) : undefined;
}

export function projectKeyForWorkspace(workspaceDir: string | undefined): string {
  return workspaceDir ? `workspace:${workspaceDir}` : DEFAULT_PROJECT_KEY;
}

export interface SessionProjectProjectionDeps {
  resolveDefaultWorkspaceDir(): string;
  resolveSessionDefaultWorkspaceDir?(sessionId: string): string;
  resolveAgentInternalWorkspaceDir?(agentName: string): string | undefined;
}

export interface SessionProjectProjection {
  readonly projectKey: string;
  readonly workspaceDir?: string;
  readonly defaultReason?:
    | 'run-default-flag'
    | 'runtime-default'
    | 'session-default'
    | 'agent-default'
    | 'legacy-data-dir-alias';
}

/** The single lexical Session → canonical Project projection used by Desktop and Channel. */
export function projectForSession(
  session: LocalSessionRecord,
  deps: SessionProjectProjectionDeps,
): SessionProjectProjection {
  if (session.runLocation !== undefined) {
    const workspaceDir = canonicalProjectWorkspaceDir(session.workspaceDir, session.runLocation);
    return {
      projectKey: projectKeyForWorkspace(workspaceDir),
      ...(workspaceDir ? { workspaceDir } : {}),
    };
  }
  if (session.isDefaultWorkspace === true) {
    return { projectKey: DEFAULT_PROJECT_KEY, defaultReason: 'run-default-flag' };
  }
  const workspaceDir = normalizeAbsolutePath(session.workspaceDir);
  if (workspaceDir === undefined) return { projectKey: DEFAULT_PROJECT_KEY };
  const defaultWorkspaceDir = normalizeAbsolutePath(deps.resolveDefaultWorkspaceDir());
  if (defaultWorkspaceDir !== undefined && workspaceDir === defaultWorkspaceDir) {
    return { projectKey: DEFAULT_PROJECT_KEY, defaultReason: 'runtime-default' };
  }
  const sessionDefaultWorkspaceDir = normalizeAbsolutePath(
    deps.resolveSessionDefaultWorkspaceDir?.(session.sessionId),
  );
  if (sessionDefaultWorkspaceDir !== undefined && workspaceDir === sessionDefaultWorkspaceDir) {
    return { projectKey: DEFAULT_PROJECT_KEY, defaultReason: 'session-default' };
  }
  if (
    isAgentInternalDefaultWorkspaceDir(
      session.workspaceDir,
      deps.resolveAgentInternalWorkspaceDir?.(session.agentName),
      session.agentName,
    )
  ) {
    return { projectKey: DEFAULT_PROJECT_KEY, defaultReason: 'agent-default' };
  }
  if (
    isLegacySessionDefaultWorkspaceDir(
      session.workspaceDir,
      sessionDefaultWorkspaceDir,
      session.sessionId,
    )
  ) {
    return { projectKey: DEFAULT_PROJECT_KEY, defaultReason: 'legacy-data-dir-alias' };
  }
  const canonical = canonicalProjectWorkspaceDir(session.workspaceDir, session.runLocation);
  return {
    projectKey: projectKeyForWorkspace(canonical),
    ...(canonical ? { workspaceDir: canonical } : {}),
  };
}

export function workspaceDirFromProjectKey(key: string | undefined): string | undefined {
  if (!key?.startsWith('workspace:')) return undefined;
  return normalizeAbsolutePath(key.slice('workspace:'.length));
}

export function projectDisplayName(workspaceDir: string | undefined): string {
  if (!workspaceDir) return 'No project selected';
  const flavor = detectPathFlavor(workspaceDir);
  return flavor.basename(workspaceDir) || workspaceDir;
}

export function normalizeAbsolutePath(value: string | undefined): string | undefined {
  const input = value?.trim();
  if (!input) return undefined;
  const flavor = detectPathFlavor(input);
  if (!flavor.isAbsolute(input)) return undefined;
  const normalized = flavor.normalize(input);
  return trimTrailingSeparators(normalized, flavor.sep);
}

/**
 * Match the one-way read alias from the historical `.mavis[-profile]` data
 * directory to the current `.minimax[-profile]` data directory.
 *
 * The alias is deliberately narrower than a general path migration: both
 * paths must be under the same parent, use the same profile suffix, contain
 * the same sessionId, and end at the exact `sessions/<id>/workspace` shape.
 * This is a lexical read-only comparison; it must not call realpath, migrate
 * data, or backfill the session record.
 */
export function isLegacySessionDefaultWorkspaceDir(
  workspaceDir: string | undefined,
  currentSessionDefaultWorkspaceDir: string | undefined,
  sessionId: string,
): boolean {
  const current = parseSessionDefaultWorkspacePath(currentSessionDefaultWorkspaceDir, sessionId);
  const legacy = parseSessionDefaultWorkspacePath(workspaceDir, sessionId);
  if (!current || !legacy || current.windows !== legacy.windows) return false;
  const sameDataDirBase = current.windows
    ? current.dataDirBase.toLowerCase() === NEW_DATA_DIR_BASENAME &&
      legacy.dataDirBase.toLowerCase() === LEGACY_DATA_DIR_BASENAME
    : current.dataDirBase === NEW_DATA_DIR_BASENAME &&
      legacy.dataDirBase === LEGACY_DATA_DIR_BASENAME;
  if (!sameDataDirBase) {
    return false;
  }
  const sameProfile = current.windows
    ? current.profileSuffix.toLowerCase() === legacy.profileSuffix.toLowerCase()
    : current.profileSuffix === legacy.profileSuffix;
  if (!sameProfile) return false;
  return pathsEqual(current.parentDir, legacy.parentDir, current.windows);
}

/** Match current and historical internal Agent fallback workspaces without filesystem access. */
export function isAgentInternalDefaultWorkspaceDir(
  workspaceDir: string | undefined,
  currentAgentWorkspaceDir: string | undefined,
  agentName: string,
): boolean {
  try {
    validateAgentName(agentName);
  } catch {
    return false;
  }
  const workspace = normalizeAbsolutePath(workspaceDir);
  const current = normalizeAbsolutePath(currentAgentWorkspaceDir);
  if (!workspace || !current) return false;
  const workspaceFlavor = detectPathFlavor(workspace);
  const currentFlavor = detectPathFlavor(current);
  if (workspaceFlavor !== currentFlavor) return false;
  const windows = currentFlavor === path.win32;
  if (pathsEqual(workspace, current, windows)) return true;

  const legacy = parseAgentWorkspacePath(workspace, agentName);
  const active = parseAgentWorkspacePath(current, agentName);
  if (!legacy || !active || legacy.windows !== active.windows) return false;
  const sameDataDirBase = windows
    ? active.dataDirBase.toLowerCase() === NEW_DATA_DIR_BASENAME &&
      legacy.dataDirBase.toLowerCase() === LEGACY_DATA_DIR_BASENAME
    : active.dataDirBase === NEW_DATA_DIR_BASENAME &&
      legacy.dataDirBase === LEGACY_DATA_DIR_BASENAME;
  return (
    sameDataDirBase &&
    pathsEqual(active.parentDir, legacy.parentDir, windows) &&
    pathsEqual(active.profileSuffix, legacy.profileSuffix, windows)
  );
}

function collapseWorktreeDir(workspaceDir: string): string {
  const flavor = detectPathFlavor(workspaceDir);
  const root = flavor.parse(workspaceDir).root;
  const relativePath = workspaceDir.slice(root.length);
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  const markerIndex = findWorktreeMarkerIndex(parts);
  if (markerIndex === undefined) return workspaceDir;
  const parentParts = parts.slice(0, markerIndex);
  const collapsed = `${root}${parentParts.join(flavor.sep)}`;
  return trimTrailingSeparators(collapsed, flavor.sep);
}

interface SessionDefaultWorkspacePath {
  windows: boolean;
  parentDir: string;
  dataDirBase: string;
  profileSuffix: string;
}

function parseAgentWorkspacePath(
  value: string,
  agentName: string,
): SessionDefaultWorkspacePath | undefined {
  const flavor = detectPathFlavor(value);
  const windows = flavor === path.win32;
  const root = flavor.parse(value).root;
  const parts = value
    .slice(root.length)
    .split(windows ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  if (parts.length < 4) return undefined;
  if (
    !samePathPart(parts.at(-1), 'workspace', windows) ||
    !samePathPart(parts.at(-2), agentName, windows) ||
    !samePathPart(parts.at(-3), 'agents', windows)
  ) {
    return undefined;
  }
  const dataDirPart = parts.at(-4);
  const match = dataDirPart?.match(/^\.(minimax|mavis)(?:-(.+))?$/i);
  if (!match?.[1]) return undefined;
  return {
    windows,
    parentDir: `${root}${parts.slice(0, -4).join(flavor.sep)}`,
    dataDirBase: `.${match[1]}`,
    profileSuffix: match[2] ?? '',
  };
}

/**
 * Parser-only: lexically parses absolute `<parent>/.{mavis|minimax}[-profile]/sessions/<sessionId>/workspace`
 * candidates and extracts `windows`, `parentDir`, `dataDirBase`, and `profileSuffix`.
 * It validates the exact suffix shape and supplied `sessionId`; the caller compares alias
 * direction and parent/profile equality in `isLegacySessionDefaultWorkspaceDir`.
 * POSIX uses case-sensitive `/`; Windows uses win32 separators/case semantics.
 * No filesystem access, `realpath`, migration, or data writes occur.
 */
function parseSessionDefaultWorkspacePath(
  value: string | undefined,
  sessionId: string,
): SessionDefaultWorkspacePath | undefined {
  if (!sessionId || /[\\/]/.test(sessionId)) return undefined;
  const normalized = normalizeAbsolutePath(value);
  if (!normalized) return undefined;
  const flavor = detectPathFlavor(normalized);
  const windows = flavor === path.win32;
  const root = flavor.parse(normalized).root;
  const parts = normalized
    .slice(root.length)
    .split(windows ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  if (parts.length < 4) return undefined;

  const workspacePart = parts.at(-1);
  const sessionPart = parts.at(-2);
  const sessionsPart = parts.at(-3);
  if (
    !samePathPart(workspacePart, 'workspace', windows) ||
    !samePathPart(sessionPart, sessionId, windows) ||
    !samePathPart(sessionsPart, 'sessions', windows)
  ) {
    return undefined;
  }

  const dataDirPart = parts.at(-4);
  const dataDirMatch = dataDirPart?.match(/^\.(minimax|mavis)(?:-(.+))?$/i);
  if (!dataDirMatch) return undefined;
  const dataDirBase = dataDirMatch[1];
  if (!dataDirBase) return undefined;
  const dataDirIndex = parts.length - 4;
  const parentDir = `${root}${parts.slice(0, dataDirIndex).join(flavor.sep)}`;
  return {
    windows,
    parentDir,
    dataDirBase: `.${dataDirBase}`,
    profileSuffix: dataDirMatch[2] ?? '',
  };
}

function samePathPart(left: string | undefined, right: string, windows: boolean): boolean {
  if (left === undefined) return false;
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathsEqual(left: string, right: string, windows: boolean): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findWorktreeMarkerIndex(parts: string[]): number | undefined {
  const simpleIndex = parts.findIndex((part) => part === '.worktrees' || part === '.worktree');
  if (simpleIndex >= 0 && simpleIndex < parts.length - 1) return simpleIndex;
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === '.claude' && parts[index + 1] === 'worktrees') return index;
  }
  return undefined;
}

function detectPathFlavor(value: string): typeof path.posix | typeof path.win32 {
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return path.win32;
  return path.posix;
}

function trimTrailingSeparators(value: string, sep: string): string {
  if (value === sep) return value;
  if (/^[A-Za-z]:\\$/.test(value)) return value;
  if (value.startsWith('\\\\') && /^\\\\[^\\]+\\[^\\]+\\?$/.test(value)) {
    return value.endsWith('\\') ? value.slice(0, -1) : value;
  }
  let result = value;
  while (result.length > 1 && (result.endsWith('/') || result.endsWith('\\'))) {
    result = result.slice(0, -1);
  }
  return result;
}
