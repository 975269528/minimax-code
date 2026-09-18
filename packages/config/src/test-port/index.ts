/**
 * Test port allocation — derive preferred ports from the worktree's branch
 * port slot, with bind-check + fallback so multiple worktrees can run E2E
 * and smoke suites concurrently without colliding on hard-coded 5050/15001.
 *
 * Why this exists
 * ---------------
 * The previous test infra hard-coded:
 *   - runtime port 5050  (packages/ui/test/e2e/global-setup.ts)
 *   - UI port    15001   (playwright.config.ts; --strictPort)
 *   - smoke runtime: random getFreePort + browser-broker.sock that hit macOS
 *     sun_path 104B limit (already fixed via /tmp + mkdtempSync in commit
 *     917779937; this module preserves that behaviour)
 *
 * Two real failure modes resulted:
 *   1. Two worktrees running E2E in parallel both grab 5050/15001 and one
 *      EADDRINUSE-fails immediately or — worse — the second silently shares
 *      the first's runtime and crosses test state.
 *   2. A runtime discovery fallback can route every `/mavis/api/*` request
 *      away from the test runtime, causing UI E2E to render real session data
 *      instead of the test runtime's empty state. Fixed structurally by making
 *      the Vite proxy honour explicit test runtime ports over discovery.
 *
 * Design
 * ------
 * - Use the same `detectGitPortInfo()` slot the worktree's app runtime uses,
 *   plus a stable per-role offset above the app runtime slot.
 * - Different role (e2e-runtime, e2e-ui, smoke-runtime) → different
 *   offset. Same role + same worktree → stable preferred port across runs
 *   (deterministic, easier to debug).
 * - Different worktree → different branch slot → different preferred port
 *   (concurrent-safe by construction).
 * - Outside a recognized worktree (e.g. CI clone, DEFAULT_PORT path) the
 *   offset still applies on top of `DEFAULT_PORT` so the role offsets stay
 *   contiguous; binding still falls back to a free port if the preferred
 *   one is taken.
 * - Hard rule: role offsets MUST NOT collide with the app runtime (offset 0).
 *   Test offsets start at +5000 to give the app generous headroom.
 *
 * Bind-check + fallback
 * ---------------------
 * `pickTestPort(role)`:
 *   1. compute preferred = base + offset[role]
 *   2. try to listen() on preferred (loopback, port 0-bind to verify libuv
 *      can grab it without leaving a socket behind). If successful, close
 *      and return preferred.
 *   3. if EADDRINUSE / EACCES, fall back to OS-assigned `getFreePort()`.
 *
 * The bind check happens before the runtime/Vite spawn, so a busy preferred
 * port never produces an EADDRINUSE startup failure deep in the test
 * harness — caller always gets a port that was free at decision time.
 * (TOCTOU race window is small but non-zero; runtime startup handles
 * EADDRINUSE conventionally.)
 */

import net from 'node:net';
import { detectGitPortInfo, DEFAULT_PORT } from '../config.js';

// ─── Role registry ────────────────────────────────────────────────────────

/**
 * Test port roles. Add new roles here only after confirming they don't
 * collide with the app runtime (offset 0).
 */
export type TestPortRole = 'e2e-runtime' | 'e2e-ui' | 'smoke-runtime';

/**
 * Stable offsets above app runtime (0).
 * Spaced 500 apart so each role has slack and so future roles have room
 * (e.g. 'integration-runtime', 'pop-up-mcp', etc.).
 *
 * KEEP IN SYNC with `TestPortRole`. Adding a role without an offset will
 * fail typecheck.
 */
export const TEST_PORT_ROLE_OFFSET: Readonly<Record<TestPortRole, number>> = {
  'e2e-runtime': 5000,
  'e2e-ui': 5500,
  'smoke-runtime': 7000,
};

/**
 * Floor that all role offsets must clear. App runtime = 0.
 */
export const TEST_PORT_ROLE_FLOOR = 100;

// ─── Public API ───────────────────────────────────────────────────────────

export interface PickTestPortOptions {
  /** Inject port-bind check (used by tests). Defaults to live `net.createServer`. */
  isPortFree?: (port: number) => Promise<boolean>;
  /** Inject free-port allocator (used by tests). Defaults to live OS-assigned. */
  getFreePort?: () => Promise<number>;
  /** Inject branch slot resolver (used by tests). Defaults to git auto-detect. */
  getWorktreeBasePort?: () => number;
}

/**
 * Returns a port assigned to `role` that is free at decision time.
 * - Preferred port = worktree branch slot + role offset.
 * - Fallback path = OS-assigned free port.
 *
 * Caller is responsible for spawning their service on the returned port
 * promptly (TOCTOU window is small; runtime startup handles EADDRINUSE).
 */
export async function pickTestPort(
  role: TestPortRole,
  opts: PickTestPortOptions = {},
): Promise<number> {
  const isPortFree = opts.isPortFree ?? defaultIsPortFree;
  const getFreePort = opts.getFreePort ?? defaultGetFreePort;
  const getWorktreeBasePort = opts.getWorktreeBasePort ?? defaultGetWorktreeBasePort;

  const preferred = getWorktreeBasePort() + TEST_PORT_ROLE_OFFSET[role];

  // Defensive guard: refuse to return a port at offset 0 (app runtime).
  // If a future role offset gets
  // mis-set in TEST_PORT_ROLE_OFFSET, this catches it before we steal
  // the user's dev runtime port.
  const reservedOffset = preferred - getWorktreeBasePort();
  if (reservedOffset < TEST_PORT_ROLE_FLOOR) {
    throw new Error(
      `pickTestPort(${role}): role offset ${reservedOffset} collides with ` +
        'app runtime (0); ' +
        `must be >= ${TEST_PORT_ROLE_FLOOR}.`,
    );
  }

  if (preferred > 65535) {
    return getFreePort();
  }

  if (await isPortFree(preferred)) return preferred;
  return getFreePort();
}

// ─── Defaults (live OS bindings) ──────────────────────────────────────────

function defaultGetWorktreeBasePort(): number {
  // Mirrors resolvePort() except it never reads __MAVIS_RUNTIME_PORT — test
  // ports are derived from the worktree slot, not from explicit env, so
  // multiple parallel test runs in the same worktree get the same slot
  // (preferred) and the bind-check arbitrates between them.
  const gitInfo = detectGitPortInfo();
  return gitInfo.autoDetected ? gitInfo.runtimePort : DEFAULT_PORT;
}

async function defaultIsPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function defaultGetFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to get free port')));
      }
    });
    srv.on('error', reject);
  });
}
