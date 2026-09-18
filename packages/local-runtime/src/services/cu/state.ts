/**
 * Computer Use state — process-singleton enable gate + in-flight AbortController registry.
 *
 * Architecture context:
 *  - The `cu-mode-v1` plan shipped UI scaffolding (toggle / banner / permission flow / dock-restore)
 *    but never wired the agent end. v2 adds a local-runtime-hosted MCP server (`/mcp/cu`) that exposes
 *    desktop_* tools. The OpenCode runtime reaches the tools over HTTP MCP.
 *  - This module is the single in-process gate everything reads:
 *      * `enabled`   — flipped by the renderer's `cuStore.enabled` via `PUT /api/cu/enabled`.
 *      * `inflight`  — AbortControllers keyed by tool-call id; aborted by `POST /api/cu/abort`
 *                      (renderer dock-restore handler / explicit toggle off).
 *  - Native impl (`./native.ts`) and MCP server (`../../api/cu-mcp.ts`) both consult this module.
 *    No DI — there is exactly one local-runtime process and one shared CU state.
 */
import { logger } from '../../hooks/engine/host-utils.js';

export interface CuStateSnapshot {
  enabled: boolean;
  inflightCount: number;
  lastChangedAtMs: number;
  workspaceDir?: string;
}

interface CuStateInternal {
  enabled: boolean;
  /** Workspace directory of the session that enabled CU. */
  workspaceDir: string | undefined;
  inflight: Map<string, AbortController>;
  lastChangedAtMs: number;
}

const state: CuStateInternal = {
  enabled: false,
  workspaceDir: undefined,
  inflight: new Map(),
  lastChangedAtMs: Date.now(),
};

/** Read-only view for diagnostics / `GET /api/cu/status`. */
export function snapshot(): CuStateSnapshot {
  return {
    enabled: state.enabled,
    inflightCount: state.inflight.size,
    lastChangedAtMs: state.lastChangedAtMs,
    workspaceDir: state.workspaceDir,
  };
}

/**
 * Flip the renderer toggle. Called by `PUT /api/cu/enabled`.
 * When enabling, optionally stores the calling session's workspace directory
 * so screenshot persistence can save files there.
 * When disabling, also aborts every in-flight tool call so the framework gets
 * fast errors instead of hanging on detached operations.
 */
export function setEnabled(
  enabled: boolean,
  workspaceDir?: string,
): { changed: boolean; aborted: number } {
  const was = state.enabled;
  // Always update workspaceDir when provided, even if enabled state didn't change.
  // The renderer may re-send setEnabled(true) after switching sessions/workspaces.
  if (workspaceDir !== undefined) {
    state.workspaceDir = workspaceDir;
  }
  if (was === enabled) return { changed: false, aborted: 0 };
  state.enabled = enabled;
  state.workspaceDir = enabled ? workspaceDir : undefined;
  state.lastChangedAtMs = Date.now();
  let aborted = 0;
  if (!enabled) {
    aborted = abortAll('cuMode disabled');
  }
  logger.info(
    `[cu] enabled changed: ${was} -> ${enabled}${workspaceDir ? ` workspace=${workspaceDir}` : ''}${aborted ? ` (aborted ${aborted} in-flight)` : ''}`,
  );
  return { changed: true, aborted };
}

export function isEnabled(): boolean {
  return state.enabled;
}

/** Workspace directory of the session that enabled CU (if any). */
export function getWorkspaceDir(): string | undefined {
  return state.workspaceDir;
}

/**
 * Register an AbortController for an in-flight tool call. Returns the same
 * controller back so callers can `signal` it directly. The id should be the
 * MCP tool-call id (or any unique identifier the caller chooses).
 */
export function registerInflight(id: string): AbortController {
  const controller = new AbortController();
  state.inflight.set(id, controller);
  return controller;
}

export function unregisterInflight(id: string): void {
  state.inflight.delete(id);
}

/**
 * Abort all in-flight calls (called by `POST /api/cu/abort` and on disable).
 * Returns the number of controllers signalled.
 */
export function abortAll(reason: string): number {
  const count = state.inflight.size;
  if (count === 0) return 0;
  for (const [, controller] of state.inflight) {
    try {
      controller.abort(reason);
    } catch {
      // ignore — already aborted
    }
  }
  state.inflight.clear();
  return count;
}

/**
 * Test-only: reset state. Not exported from the package index intentionally —
 * production code should never reset.
 * @internal
 */
export function __resetForTests(): void {
  state.enabled = false;
  state.workspaceDir = undefined;
  state.inflight.clear();
  state.lastChangedAtMs = Date.now();
}
