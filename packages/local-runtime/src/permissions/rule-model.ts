export type LocalPermissionBehavior = 'allow' | 'deny' | 'ask';
export type LocalPermissionRuleSource = 'global' | 'agent' | 'session';
export type LocalPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto' | 'off';
export type LocalPermissionAction = 'read' | 'write' | 'delete' | 'execute' | 'network';

export type LocalPermissionMatcher =
  | { kind: 'tool' }
  | { kind: 'command'; pattern: string }
  | { kind: 'path'; pattern: string; actions?: readonly LocalPermissionAction[] };

export interface LocalPermissionRuleValue {
  toolName: string;
  ruleContent?: string;
  matcher?: LocalPermissionMatcher;
}

export interface LocalPermissionRule {
  source: LocalPermissionRuleSource;
  ruleBehavior: LocalPermissionBehavior;
  ruleValue: LocalPermissionRuleValue;
  destination: string;
}

export interface LocalPermissionDecision {
  behavior: LocalPermissionBehavior;
  reason: string;
  rule?: LocalPermissionRule;
}

export class LocalPermissionRuleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'LocalPermissionRuleError';
  }
}

export type LocalPermissionStoreUnhealthyReason =
  | 'corrupt-json'
  | 'invalid-store-shape'
  | 'unsupported-version'
  | 'invalid-v2-rule';

export class LocalPermissionStoreUnhealthyError extends LocalPermissionRuleError {
  constructor(
    readonly reasonCode: LocalPermissionStoreUnhealthyReason,
    readonly source: LocalPermissionRuleSource,
  ) {
    super(
      reasonCode === 'unsupported-version'
        ? 'Unsupported permission.json version.'
        : `Permission rule store is unhealthy: ${reasonCode}.`,
      503,
    );
    this.name = 'LocalPermissionStoreUnhealthyError';
  }
}
