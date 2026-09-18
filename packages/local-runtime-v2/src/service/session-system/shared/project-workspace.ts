import type { SessionRunLocation } from '../sessions/repo/contract.js';
import { normalizeAbsolutePath } from './path-normalization.js';
import {
  isAgentInternalDefaultWorkspaceDir,
  isSessionDefaultWorkspaceDir,
} from './workspace.js';

export interface ProjectWorkspaceClassificationInput {
  readonly sessionId: string;
  readonly workspaceDir: string | undefined;
  readonly explicitIsDefaultWorkspace?: boolean;
  readonly implicitDefaultWorkspace?: boolean;
  readonly runLocation?: SessionRunLocation;
  readonly defaultWorkspaceDir: string | undefined;
  readonly sessionDefaultWorkspaceDir?: string;
  readonly agentInternalWorkspaceDir?: string;
  readonly agentName?: string;
}

interface LegacyProjectWorkspaceSource {
  readonly sessionId: string;
  readonly workspaceDir: string | undefined;
  readonly isDefaultWorkspace?: boolean;
}

interface LegacyProjectWorkspaceExisting extends LegacyProjectWorkspaceSource {
  readonly runLocation?: SessionRunLocation;
}

/**
 * Classify whether a Session belongs to the default Project.
 *
 * An explicit run location always wins over default-workspace compatibility;
 * this preserves the Project selected by a worktree Session even when an
 * older record carries a stale default flag.
 */
export function isDefaultProjectWorkspace(input: ProjectWorkspaceClassificationInput): boolean {
  if (input.explicitIsDefaultWorkspace === false) return false;
  if (hasWorkspaceProjectRunLocation(input.runLocation)) return false;
  if (input.implicitDefaultWorkspace === true) return true;
  if (input.explicitIsDefaultWorkspace === true) return true;

  const workspaceDir = normalizeAbsolutePath(input.workspaceDir);
  if (!workspaceDir) return true;

  return isKnownDefaultProjectWorkspace(input, workspaceDir);
}

function isKnownDefaultProjectWorkspace(
  input: ProjectWorkspaceClassificationInput,
  workspaceDir: string,
): boolean {
  return (
    matchesDefaultWorkspace(workspaceDir, input.defaultWorkspaceDir) ||
    matchesAgentInternalWorkspace(input, workspaceDir) ||
    matchesDefaultWorkspace(workspaceDir, input.sessionDefaultWorkspaceDir) ||
    isSessionDefaultWorkspaceDir(workspaceDir, input.sessionId)
  );
}

function matchesDefaultWorkspace(workspaceDir: string, candidate: string | undefined): boolean {
  return workspaceDir === normalizeAbsolutePath(candidate);
}

function matchesAgentInternalWorkspace(
  input: ProjectWorkspaceClassificationInput,
  workspaceDir: string,
): boolean {
  const agentName = input.agentName;
  return (
    agentName !== undefined &&
    isAgentInternalDefaultWorkspaceDir(
      workspaceDir,
      input.agentInternalWorkspaceDir,
      agentName,
    )
  );
}

function hasWorkspaceProjectRunLocation(runLocation: SessionRunLocation | undefined): boolean {
  return runLocation !== undefined;
}

/**
 * Recover daemon-era Sessions that reused another default Session's runtime-owned workspace.
 * Persisted false values are not authoritative for legacy-opencode rows because the old source
 * schema did not store this provenance.
 */
export function deriveLegacyDefaultProjectSessionIds(input: {
  readonly sources: readonly LegacyProjectWorkspaceSource[];
  readonly existing: readonly LegacyProjectWorkspaceExisting[];
  readonly defaultWorkspaceDir: string;
}): ReadonlySet<string> {
  const existingById = new Map(input.existing.map((session) => [session.sessionId, session]));
  const defaultWorkspaces = new Set(
    input.existing.flatMap((session) =>
      session.isDefaultWorkspace === true && session.runLocation === undefined
        ? normalizedWorkspace(session.workspaceDir)
        : [],
    ),
  );
  const eligibleWorkspaceById = new Map<string, string>();
  const defaults = new Set<string>();

  input.sources.forEach((source) => {
    const existing = existingById.get(source.sessionId);
    if (existing?.runLocation !== undefined) return;
    const workspaceDir = existing?.workspaceDir || source.workspaceDir || input.defaultWorkspaceDir;
    const workspace = normalizeAbsolutePath(workspaceDir);
    if (workspace) eligibleWorkspaceById.set(source.sessionId, workspace);
    const classified = isDefaultProjectWorkspace({
      sessionId: source.sessionId,
      workspaceDir,
      explicitIsDefaultWorkspace:
        source.isDefaultWorkspace === true || existing?.isDefaultWorkspace === true
          ? true
          : undefined,
      defaultWorkspaceDir: input.defaultWorkspaceDir,
    });
    if (!classified) return;
    defaults.add(source.sessionId);
    if (workspace) defaultWorkspaces.add(workspace);
  });

  eligibleWorkspaceById.forEach((workspace, sessionId) => {
    if (defaultWorkspaces.has(workspace)) defaults.add(sessionId);
  });
  return defaults;
}

function normalizedWorkspace(workspaceDir: string | undefined): string[] {
  const normalized = normalizeAbsolutePath(workspaceDir);
  return normalized ? [normalized] : [];
}
