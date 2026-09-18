export interface ChannelAgentReadScope {
  canonicalName: string;
  primaryName?: string;
  compatibleNames?: readonly string[];
  exactOwnerName?: string;
  trustedBuiltin?: boolean;
}

export type ChannelAgentReadScopeResolver = (
  requestedName: string,
) => Promise<ChannelAgentReadScope>;

export interface ChannelAgentOwnerIdentity {
  exactOwnerName: string;
  ownerKind: 'builtin' | 'custom';
  ownerInstanceId?: string;
}

/**
 * Compare a persisted Channel/Session owner fence with the currently resolved
 * owner. Custom Agents always require the exact name + incarnation. Builtins
 * may cross names only when the shared resolver proves both names belong to
 * the same trusted primary family (for example historical `main` and current
 * `mavis`).
 */
export async function isCompatibleChannelAgentOwner(input: {
  persisted: { exactOwnerName: string; ownerInstanceId?: string };
  current: ChannelAgentOwnerIdentity;
  resolveAgentReadScope?: ChannelAgentReadScopeResolver;
}): Promise<boolean> {
  if (input.current.ownerKind === 'custom') {
    return (
      input.current.exactOwnerName === input.persisted.exactOwnerName &&
      input.current.ownerInstanceId === input.persisted.ownerInstanceId
    );
  }
  if (input.persisted.ownerInstanceId !== undefined) return false;
  if (input.current.exactOwnerName === input.persisted.exactOwnerName) return true;
  if (!input.resolveAgentReadScope) return false;

  try {
    const scope = await input.resolveAgentReadScope(input.current.exactOwnerName);
    const canonicalName = scope.canonicalName.trim();
    const primaryName = scope.primaryName?.trim();
    if (
      scope.trustedBuiltin !== true ||
      !canonicalName ||
      !primaryName ||
      canonicalName !== primaryName
    ) {
      return false;
    }
    const family = new Set(
      [canonicalName, primaryName, scope.exactOwnerName, ...(scope.compatibleNames ?? [])].filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      ),
    );
    return family.has(input.current.exactOwnerName) && family.has(input.persisted.exactOwnerName);
  } catch {
    return false;
  }
}

/** Keep one unreadable legacy Agent local to its route; storage failures still propagate. */
export function historicalChannelAgentReadErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { code, reason } = error as { code?: unknown; reason?: unknown };
  if (reason === 'agent-not-found') return 'AGENT_NOT_FOUND';
  if (
    typeof code === 'string' &&
    [
      'AGENT_NOT_FOUND',
      'AGENT_CONFIG_NOT_FOUND',
      'AGENT_CONFIG_INVALID',
      'AGENT_CONFIG_UNSTABLE',
      'AGENT_CONFIG_INSTANCE_CONFLICT',
      'CANONICAL_AGENT_NOT_AVAILABLE',
    ].includes(code)
  )
    return code;
  return undefined;
}
