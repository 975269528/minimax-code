/**
 * Effective Computer Use availability gate shared by tool and skill injection.
 *
 * The configured beta gate is authoritative and fail-closed. External stable
 * releases additionally keep CU disabled, while internal/inside production
 * variants and non-production builds may expose it when the gate is enabled.
 */
export function isCuModeAvailable(
  gateEnabled: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (gateEnabled !== true) return false;
  if (env.MAVIS_BUILD_ENV !== 'prod') return true;
  return env.__MAVIS_BUILD_INTERNAL === 'true' || env.__MAVIS_BUILD_INSIDE === 'true';
}

/** CU tools use the shared desktop_* namespace across native and MCP paths. */
export function isCuRuntimeToolName(name: string): boolean {
  return name.startsWith('desktop_');
}

/** Built-in skill exposed alongside the CU runtime tools. */
export const CU_DESKTOP_SKILL_NAME = 'cu-desktop';

/**
 * Turn-scoped CU model exposure gate.
 *
 * Product/build availability and the renderer toggle are separate inputs:
 * callers snapshot both once per turn and pass the resolved value through
 * prompt and tool assembly.
 */
export function isCuModeActive(
  gateEnabled: boolean | undefined,
  modeEnabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return modeEnabled && isCuModeAvailable(gateEnabled, env);
}
