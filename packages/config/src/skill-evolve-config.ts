/**
 * Skill-evolve configuration types + lifecycle helpers. Extracted from
 * `config.ts` to keep the main schema file under the 2_000-line guard.
 *
 * The runtime parser `parseSkillEvolveConfig` and `DEFAULTS.skillEvolve`
 * remain in `config.ts` because they depend on `parseBetaConfig`,
 * `collectModelIds`, and a shared `DEFAULTS` constant — moving them
 * here would create a circular import.
 */

export interface SkillEvolveInSessionConfig {
  /** Trigger a scan every N agent turns. */
  N: number;
  /** Minimum seconds between two scans in the same session. */
  minIntervalSeconds: number;
  /** Maximum pending scans per session (no new scan while one is in flight). */
  maxPendingPerSession: number;
}

/** Lifecycle thresholds (15d/30d defaults; legacy 30d/90d). Schema enforces stale < archive. */
export interface SkillEvolveLifecycleConfig {
  /** Days idle before `state='stale'`. */
  staleThresholdDays: number;
  /** Days idle before non-builtin moved to `.archive/`. */
  archiveThresholdDays: number;
}

export interface SkillEvolveConfig {
  /**
   * Master switch. When false, signal collection, scanning, routing, and
   * editor spawning are all disabled. API endpoints return 403.
   *
   * Auto-derived when not explicitly set in config.yaml: if **all**
   * configured model IDs start with a prefix in `disableModelPrefixes`
   * (case-insensitive), defaults to `false`; otherwise `true`.
   * No models configured also defaults to `false`.
   * An explicit `enabled: true/false` in config.yaml always wins.
   */
  enabled: boolean;
  /** In-session scan throttle parameters. */
  inSession: SkillEvolveInSessionConfig;
  /** Cooldown hours for same-skill same-fingerprint signals (default 24). */
  signalCooldownHours: number;
  /** Minimum confidence for scanner output (below → auto-downgrade or discard). */
  minConfidence: number;
  /** Model for the passive scanner LLM calls. */
  scannerModel?: string;
  /** Agent names excluded from signal generation (e.g. 'skill-editor'). */
  excludeAgents: string[];
  /**
   * Model ID prefixes for which skill-evolve is disabled per-session.
   * When the resolved model ID starts with any of these prefixes,
   * skill-evolve teaching and scan triggers are suppressed for that session.
   * Also used to auto-derive the global `enabled` flag when it is not
   * explicitly set: if all configured model IDs match one of these prefixes
   * (or no models are configured), `enabled` defaults to `false`.
   * Default: ['MiniMax-M2'].
   */
  disableModelPrefixes: string[];
  /**
   * Whether the nightly evolver may handle built-in skill signals by
   * dispatching a worker that opens a GitLab MR against the daemon source
   * repo. When false, built-in signals are dismissed (legacy behavior).
   *
   * Mirrors `BetaConfig.skillEvolveBuiltinMr` — the beta gate is limited to
   * the test channel and wins first; this resolved field is what the
   * internal-scheduler reads when injecting capability hints into the
   * `skill-evolve-nightly` SKILL.md prompt.
   *
   * Default `false` — opt-in. Even with the beta gate enabled, opening MRs
   * against a source repo is an externally visible side effect, so users
   * must explicitly set `skillEvolve.builtinMrEnabled: true` (alongside
   * `sourceRepo`) to participate. Mirrors the `sourceRepo: undefined`
   * default — both must be set together.
   *
   * Implicitly false when the parent `enabled` is false (no point evolving
   * built-ins if the whole pipeline is off).
   */
  builtinMrEnabled: boolean;
  /**
   * Optional absolute path to the source repository used for built-in skill
   * evolution MRs. Runtime built-in skills usually live under the dataDir copy
   * (`.minimax/.builtin-skills`), so walking up from that directory cannot find
   * the repo in packaged/dev-profile installs. When set, the internal nightly
   * scheduler validates this path and uses it as the MR source repo.
   */
  sourceRepo?: string;
  /**
   * v3: skill creation proposal pipeline (session-end fallback re-prompt
   * → ProposalStore → nightly skill-evolve consumes). When the parent
   * `enabled` is false, all proposal sub-features are forced off.
   *
   * Mirrors `BetaConfig.skillProposal` — its beta definition defaults through
   * test and is configurable through online. That gate wins first; this
   * resolved object is what the daily-digest fallback and scanner read.
   */
  proposal: SkillEvolveProposalConfig;
  /** Lifecycle thresholds — see `SkillEvolveLifecycleConfig`. */
  lifecycle: SkillEvolveLifecycleConfig;
}

/**
 * v3: proposal pipeline configuration. Controls who receives the
 * session-end fallback re-prompt for skill reflection and whether the
 * legacy session-end passive scanner is suppressed in favor of the new flow.
 */
export interface SkillEvolveProposalConfig {
  /**
   * Resolved master switch. False when:
   *   - `skillEvolve.enabled` is false (parent gate)
   *   - `beta.skillProposal` is false (beta gate)
   * True when both gates are on.
   */
  enabled: boolean;
  /**
   * Agent name allow-list for fallback re-prompt + skill reflection.
   * Special value `["*"]` enables all agents.
   * Default: `["mavis"]`.
   */
  eligibleAgents: string[];
  /**
   * Minimum message count before a session is eligible for skill-reflection
   * re-prompt (independent of the memory-fallback minimum). Default: 40.
   */
  minMessageCount: number;
  /**
   * When true (default in v3), the passive scanner does NOT subscribe to
   * `session.finish` / `session.error` / `session.compressed` EventBus
   * events — the daily-digest fallback re-prompt covers that need with
   * higher accuracy (the original agent reflects on its own conversation).
   *
   * The in-session `scan-request` path is unaffected and continues to fire.
   *
   * Set to `false` to keep the legacy v2 behavior (both paths produce
   * signals, expect duplicate signal volume).
   */
  skipPassiveSessionEnd: boolean;
}

/**
 * v3 helper: check whether an agent is in the proposal eligibility list.
 *
 * - `["*"]` matches every agent
 * - Otherwise an exact name match
 *
 * Empty list always returns false.
 */
export function isProposalEligibleAgent(agentName: string, eligibleAgents: string[]): boolean {
  if (eligibleAgents.length === 0) return false;
  if (eligibleAgents.includes('*')) return true;
  return eligibleAgents.includes(agentName);
}
