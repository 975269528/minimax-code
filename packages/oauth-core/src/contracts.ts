export const MCODE_OAUTH_CLIENT_ID = 'mcode-public' as const;
export const MCODE_OAUTH_SCOPES = ['agent.default'] as const;
export const MCODE_OAUTH_AUDIENCE = 'agent-backend' as const;

export type AuthBuildEnv = 'dev' | 'test' | 'staging' | 'prod';
export type AuthRegion = 'cn' | 'en';

export interface AuthNamespaceInput {
  dataDir: string;
  buildEnv: AuthBuildEnv;
  region: AuthRegion;
}

export interface AccessTokenLease {
  accessToken: string;
  /** Stable across refresh, replaced by every interactive login. Absent on legacy credentials. */
  loginEpoch?: string;
  expiresAtMs: number;
  generation: number;
  scopes: typeof MCODE_OAUTH_SCOPES;
  audience: typeof MCODE_OAUTH_AUDIENCE;
}

export interface UnauthorizedContext {
  generation: number;
  loginEpoch?: string;
}
