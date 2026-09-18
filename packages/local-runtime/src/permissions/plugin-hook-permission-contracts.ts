import type { PermissionRule } from '@mavis/permission';

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

/** Structural projection of the validated Hook permission mutation contract. */
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

export const PLUGIN_HOOK_PERMISSION_STORE_VERSION = 1;

export type PersistablePluginHookPermissionMode = Exclude<
  PluginHookPermissionUpdateMode,
  'plan' | 'bypassPermissions'
>;

export interface PluginHookPermissionScopeState {
  readonly rules: {
    readonly allow: readonly PluginHookPermissionRuleValue[];
    readonly deny: readonly PluginHookPermissionRuleValue[];
    readonly ask: readonly PluginHookPermissionRuleValue[];
  };
  readonly directories: readonly string[];
  readonly mode?: PersistablePluginHookPermissionMode | 'bypassPermissions';
}

export interface PluginHookWorkspacePermissionScope {
  readonly workspace: string;
  readonly state: PluginHookPermissionScopeState;
}

export interface PersistedPluginHookPermissionState {
  readonly version: typeof PLUGIN_HOOK_PERMISSION_STORE_VERSION;
  readonly user: PluginHookPermissionScopeState;
  readonly projects: Readonly<Record<string, PluginHookWorkspacePermissionScope>>;
  readonly locals: Readonly<Record<string, PluginHookWorkspacePermissionScope>>;
}

export interface LocalPluginHookEffectivePermissions {
  readonly mode?: Exclude<PluginHookPermissionUpdateMode, 'plan'>;
  readonly rules: readonly PermissionRule[];
  readonly directories: readonly string[];
}

export interface LocalPluginHookPermissionMutationInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly updates: readonly PluginHookPermissionUpdate[];
  /** Product-owned launch capability; Hook output can never grant it. */
  readonly bypassAvailable: boolean;
}

export class LocalPluginHookPermissionMutationError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_UPDATE' | 'UNSUPPORTED_MODE' | 'STORE_CORRUPT' | 'STORE_WRITE_FAILED',
  ) {
    super(message);
    this.name = 'LocalPluginHookPermissionMutationError';
  }
}

export interface LocalPluginHookPermissionStoreOptions {
  readonly dataDir: string;
  /** Test seam: production uses one fsync + atomic rename. */
  readonly writeAtomic?: (path: string, content: string) => Promise<void>;
}
