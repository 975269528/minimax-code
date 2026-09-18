const HIDDEN_BRANCH_EXCLUDED_PURPOSE_PREFIXES = ['peek_', 'peek:'] as const;

export interface SessionVisibilityProjection {
  readonly visibility?: string;
  readonly parentSessionId?: string;
  readonly purpose?: string;
}

export function isSurfaceableHiddenBranch(session: SessionVisibilityProjection): boolean {
  if (session.visibility !== 'hidden' || !session.parentSessionId) return false;
  const purpose = session.purpose ?? '';
  return !HIDDEN_BRANCH_EXCLUDED_PURPOSE_PREFIXES.some((prefix) => purpose.startsWith(prefix));
}
