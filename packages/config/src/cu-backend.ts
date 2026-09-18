/**
 * Computer Use backend selection — pure type-level module.
 *
 * Intentionally has **zero** Node-only imports (no `node:fs`, no
 * `js-yaml`) so this file can be consumed unchanged by the renderer
 * package via the `@mavis/config/cu-backend` sub-path export. The
 * Node-side getter/setter that touches `config.yaml` lives in
 * `cu-backend-io.ts`.
 */

/**
 * Computer Use backend implementation.
 *
 * - 'native': in-process implementation shipped with the desktop build
 *   (Electron main + native modules under apps/electron/main/modules/).
 *   This is the default and the only backend wired in this release.
 * - 'mcp': out-of-process MCP-based backend; will be added by the v2
 *   follow-up plan (vendor cu_mcp / venv installer / mcp client). Selecting
 *   this value today causes any service-layer entry point that calls
 *   {@link assertCuBackendSupported} to throw.
 */
export type CuBackend = 'native' | 'mcp';

/** Backend assumed when config.yaml omits the field or sets an invalid value. */
export const DEFAULT_CU_BACKEND: CuBackend = 'native';

/**
 * Coerce an unknown raw value (typically from `config.yaml` or the network
 * boundary) into a {@link CuBackend}. Returns {@link DEFAULT_CU_BACKEND} for
 * anything that is not a recognised backend string.
 */
export function parseCuBackend(raw: unknown): CuBackend {
  if (raw === 'native' || raw === 'mcp') return raw;
  return DEFAULT_CU_BACKEND;
}

/**
 * Guard intended for service-layer entry points that dispatch into the CU
 * backend. Throws when the configured backend has no implementation shipped
 * in this release.
 *
 * Always takes an explicit `backend` argument so this module stays free of
 * runtime dependencies on `config.yaml` — the daemon-side wrapper in
 * `cu-backend-io.ts` adds the `getCuBackend()` fallback for callers that
 * want one.
 */
export function assertCuBackendSupported(backend: CuBackend): void {
  if (backend === 'mcp') {
    throw new Error('MCP backend coming in v2 follow-up plan');
  }
}
