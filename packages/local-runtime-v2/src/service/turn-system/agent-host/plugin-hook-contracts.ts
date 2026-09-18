/** Structural Hook capability port; vendor parsing and execution stay in the Plugin adapter. */
export interface AgentHostPluginHookHandler {
  readonly kind: 'command';
  readonly sourceFormat: 'MINIMAX' | 'CLAUDE' | 'CODEX';
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly sourcePath: string;
  readonly event:
    | 'SessionStart'
    | 'SessionEnd'
    | 'UserPromptSubmit'
    | 'PreToolUse'
    | 'PermissionRequest'
    | 'PostToolUse'
    | 'SubagentStart'
    | 'SubagentStop'
    | 'Stop'
    | 'PreCompact'
    | 'PostCompact';
  readonly matcher?: string;
  readonly command: string;
  readonly timeoutMs: number;
  readonly declarationOrder: number;
}
