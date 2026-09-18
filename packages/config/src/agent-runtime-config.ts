/**
 * Agent runtime selection config — pure type-level module.
 *
 * Defines the local runtime knob for freshly-created sessions. New local
 * sessions run through Pi, while any stale session metadata is handled as
 * archive-only by the local host.
 *
 * Intentionally has **zero** Node-only imports so this file can be consumed
 * unchanged across the workspace. Config sits beneath the local/cloud runtime
 * packages in the dependency graph, so keep this module as plain data parsing.
 *
 * Keep this module Node-free so Electron, CLI, and local runtime can share it.
 */

/**
 * New local sessions have one live runtime: Pi. Existing opencode sessions
 * keep their persisted runtime and route through the legacy boundary instead
 * of this config knob.
 */
export type AgentRuntimeFramework = 'pi-agent';

/** All recognised config framework strings. Used by `parseAgentRuntimeFramework`. */
export const AGENT_RUNTIME_FRAMEWORKS: ReadonlyArray<AgentRuntimeFramework> = ['pi-agent'];

/**
 * Default runtime used when `config.yaml` omits `agentRuntime` or sets an
 * unrecognised value.
 */
export const DEFAULT_AGENT_RUNTIME_FRAMEWORK: AgentRuntimeFramework = 'pi-agent';

/**
 * User-facing config:
 *
 * ```yaml
 * agentRuntime:
 *   defaultFramework: pi-agent
 * ```
 *
 * Only affects newly-created local Pi sessions. Unknown values are treated as
 * stale config and normalized to Pi.
 */
export interface AgentRuntimeConfig {
  /** Default runtime for new root / no-parent sessions. */
  defaultFramework: AgentRuntimeFramework;
}

/**
 * Coerce an unknown raw value (typically a string from `config.yaml`) into
 * an {@link AgentRuntimeFramework}. Returns
 * {@link DEFAULT_AGENT_RUNTIME_FRAMEWORK} for anything that is not one of
 * {@link AGENT_RUNTIME_FRAMEWORKS}.
 *
 * A typo (`'pi'` instead of `'pi-agent'`) falls back to Pi instead of creating
 * another runtime mode.
 */
export function parseAgentRuntimeFramework(raw: unknown): AgentRuntimeFramework {
  if (typeof raw !== 'string') return DEFAULT_AGENT_RUNTIME_FRAMEWORK;
  if ((AGENT_RUNTIME_FRAMEWORKS as readonly string[]).includes(raw)) {
    return raw as AgentRuntimeFramework;
  }
  return DEFAULT_AGENT_RUNTIME_FRAMEWORK;
}

/**
 * Parse the `agentRuntime` section of a raw `config.yaml`. Always returns a
 * fully-populated config — missing / malformed fields fall back to defaults.
 */
export function parseAgentRuntimeConfig(raw: unknown): AgentRuntimeConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { defaultFramework: DEFAULT_AGENT_RUNTIME_FRAMEWORK };
  }
  const obj = raw as Record<string, unknown>;
  return {
    defaultFramework: parseAgentRuntimeFramework(obj.defaultFramework),
  };
}
