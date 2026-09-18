import type { AuthLeaseStatus } from '@mavis/oauth-lease-protocol';

export interface McodeToolsAccessTokenLease {
  accessToken: string;
  expiresAtMs: number;
  generation: number;
  scopes: readonly ['agent.default'];
  audience: 'agent-backend';
}

export interface McodeToolsAuthStatusSnapshot {
  status: AuthLeaseStatus;
  generation: number;
  expiresAtMs?: number;
}

export interface McodeToolsHostAuthSession {
  getStatus(): Promise<McodeToolsAuthStatusSnapshot>;
  getAccessToken(minValidityMs: number): Promise<McodeToolsAccessTokenLease>;
  handleUnauthorized(generation: number): Promise<'retry' | 'logout'>;
  watch(listener: (status: McodeToolsAuthStatusSnapshot) => void): () => void;
}

export interface McodeToolsHostLogger {
  info(message: string): void;
  warn(message: string): void;
}
