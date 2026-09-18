/** Product-level Plugin Hook events shared by Desktop and Cloud runtimes. */
export const PLUGIN_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
  'PostCompact',
] as const;

export type PluginHookEventName = (typeof PLUGIN_HOOK_EVENTS)[number];

export type PluginHookSourceFormat = 'MINIMAX' | 'CLAUDE' | 'CODEX';

export interface PluginHookEffort {
  readonly level: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export type PluginHookSessionStartSource =
  | 'startup'
  | 'resume'
  | 'clear'
  | 'compact'
  | 'fork'
  | 'plugin_activation';

export interface PluginHookCommandHandler {
  readonly kind: 'command';
  readonly sourceFormat: PluginHookSourceFormat;
  readonly pluginName: string;
  readonly pluginRoot: string;
  /** Host-owned writable state directory; the Plugin package root is immutable. */
  readonly pluginDataDir?: string;
  /** Changes whenever this Plugin capability is updated or re-activated. */
  readonly activationKey?: string;
  readonly sourcePath: string;
  readonly event: PluginHookEventName;
  readonly matcher?: string;
  readonly command: string;
  /** Compatible exec-form arguments. Omitted means shell-form command execution. */
  readonly args?: readonly string[];
  /** Compatible shell-form override. Ignored when `args` selects exec form. */
  readonly shell?: 'bash' | 'powershell';
  /** Compatible tool-input predicate such as `Bash(rm *)`. */
  readonly condition?: string;
  readonly timeoutMs: number;
  /** Codex-only per-handler model-visible context limit; 0 disables spilling. */
  readonly additionalContextLimit?: number;
  readonly declarationOrder: number;
}

export interface PluginHookDiagnostic {
  readonly code: string;
  readonly pluginName: string;
  readonly sourcePath: string;
  readonly event?: PluginHookEventName;
  readonly declarationOrder?: number;
}

export interface PluginHookSet {
  readonly handlers: readonly PluginHookCommandHandler[];
  readonly diagnostics: readonly PluginHookDiagnostic[];
}

export interface PluginHookEventInput {
  readonly event: PluginHookEventName;
  readonly sessionId: string;
  readonly turnId?: string;
  /** Path to the active root transcript. `null` is serialized when no transcript exists yet. */
  readonly transcriptPath?: string | null;
  /** Codex rollout projection; Compatible continues to use `transcriptPath`. */
  readonly codexTranscriptPath?: string | null;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode?: string;
  /** Compatible-only effective effort for events inside a tool-use context. */
  readonly effort?: PluginHookEffort;
  /** Compatible's prompt-scoped identifier. Codex uses `turnId` instead. */
  readonly promptId?: string;
  /** Internal parent/child identities used to project vendor-specific subagent semantics. */
  readonly subagentContext?: {
    readonly parentSessionId: string;
    readonly parentTurnId: string;
    readonly parentTranscriptPath?: string | null;
    readonly parentCodexTranscriptPath?: string | null;
    readonly childSessionId: string;
    readonly childTranscriptPath?: string | null;
    readonly childCodexTranscriptPath?: string | null;
  };
  /**
   * Provenance for a tool whose vendor-visible identity cannot be derived from
   * its runtime name alone. In particular, plugin MCP names are scoped only
   * when the host proves which plugin owns the server.
   */
  readonly toolProvenance?: {
    readonly kind: 'plugin_mcp' | 'plugin_host';
    readonly pluginName: string;
  };
  readonly matcherValue?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type PluginHookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer';
export type PluginHookPermissionResolution = 'allow' | 'deny' | 'abstain';
export type PluginHookPermissionAutoApproval = 'ordinary_only' | 'any_prompt';
export type PluginHookToolPermissionResolution = 'allow' | 'deny' | 'ask' | 'defer' | 'abstain';

/** Compatible-compatible destination. `cliArg` is intentionally not host-persistable. */
export type PluginHookPermissionUpdateDestination =
  | 'session'
  | 'localSettings'
  | 'projectSettings'
  | 'userSettings';

export type PluginHookPermissionUpdateMode =
  | 'default'
  | 'auto'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan';

export interface PluginHookPermissionRuleValue {
  readonly toolName: string;
  readonly ruleContent?: string;
}

/**
 * Host-neutral, fully validated form of Compatible PermissionRequest
 * `updatedPermissions`. Hosts must apply the complete array atomically.
 */
export type PluginHookPermissionUpdate =
  | {
      readonly type: 'addRules' | 'replaceRules' | 'removeRules';
      readonly rules: readonly PluginHookPermissionRuleValue[];
      readonly behavior: 'allow' | 'deny' | 'ask';
      readonly destination: PluginHookPermissionUpdateDestination;
    }
  | {
      readonly type: 'setMode';
      readonly mode: PluginHookPermissionUpdateMode;
      readonly destination: PluginHookPermissionUpdateDestination;
    }
  | {
      readonly type: 'addDirectories' | 'removeDirectories';
      readonly directories: readonly string[];
      readonly destination: PluginHookPermissionUpdateDestination;
    };

export interface PluginHookDecision {
  readonly decision: PluginHookPermissionDecision;
  /**
   * PermissionRequest-specific resolution. An omitted Hook output is `abstain`;
   * an explicit `allow` authorizes the tool without showing the product UI.
   */
  readonly permissionDecision?: PluginHookPermissionResolution;
  /**
   * Scope of a PermissionRequest allow. Compatible still evaluates deny/ask rules;
   * Codex treats the Hook verdict as the final approval.
   */
  readonly permissionAutoApproval?: PluginHookPermissionAutoApproval;
  /** PreToolUse-specific permission control, distinct from an absent verdict. */
  readonly toolPermissionDecision?: PluginHookToolPermissionResolution;
  readonly reason?: string;
  readonly additionalContext?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  /** Compatible-only permission mutations; the Desktop host owns atomic application. */
  readonly updatedPermissions?: readonly PluginHookPermissionUpdate[];
  /** Compatible PermissionRequest deny-only request to stop the active agent run. */
  readonly interrupt?: boolean;
  readonly continuePrompt?: string;
  readonly defer?: boolean;
  /** Universal Compatible/Codex control output. `false` stops the active agent run. */
  readonly continue?: boolean;
  readonly stopReason?: string;
  readonly suppressOutput?: boolean;
  readonly systemMessage?: string;
  /** Compatible-only, allowlisted terminal notification bytes for a real terminal surface. */
  readonly terminalSequence?: string;
  /** Codex PostToolUse error feedback for the next model step; never an agent hard stop. */
  readonly postToolFeedback?: string;
  /** Replacement for the model-visible tool result; audit/persistence keeps the original result. */
  readonly updatedResult?: unknown;
  /** Vendor contract that owns `updatedResult`; hosts use its native serializer. */
  readonly updatedResultFormat?: 'CLAUDE' | 'MINIMAX';
}

export interface PluginHookRunDiagnostic extends PluginHookDiagnostic {
  readonly code:
    | 'HOOK_ABORTED'
    | 'HOOK_INVALID_INPUT'
    | 'HOOK_INVALID_OUTPUT'
    | 'HOOK_PROCESS_ERROR'
    | 'HOOK_PROCESS_EXITED'
    | 'HOOK_TIMEOUT';
}

export interface PluginHookRunResult {
  readonly decision: PluginHookDecision;
  readonly diagnostics: readonly PluginHookRunDiagnostic[];
}

export interface PluginSubagentRegistration {
  readonly handlers: readonly PluginHookCommandHandler[];
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  /** Compatible prompt that triggered the subagent; distinct from the child turn id. */
  readonly parentPromptId?: string;
  readonly parentTranscriptPath?: string | null;
  readonly parentCodexTranscriptPath?: string | null;
  readonly childSessionId: string;
  readonly childTurnId: string;
  readonly agentId: string;
  readonly agentType: string;
  readonly agentTranscriptPath?: string | null;
  readonly agentCodexTranscriptPath?: string | null;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly effort?: PluginHookEffort;
}

export interface PluginHookLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface PluginHookObserver {
  onHandler(input: {
    readonly event: PluginHookEventName;
    readonly format: PluginHookSourceFormat;
    readonly outcome: 'success' | 'deny' | 'ask' | 'error' | 'timeout' | 'aborted';
    readonly durationMs: number;
    readonly processKilled: boolean;
  }): void;
  onEvent(input: {
    readonly event: PluginHookEventName;
    readonly outcome: 'success' | 'deny' | 'ask' | 'degraded' | 'timeout' | 'aborted';
    readonly durationMs: number;
  }): void;
}
