/**
 * Persisted marker for the token-driven default avatar introduced for newly
 * created Custom Agents. It is deliberately a closed wire format: historical
 * URL/data/file avatar values can never be mistaken for a generated avatar.
 */
const DEFAULT_AGENT_AVATAR_MARKER_PREFIX = 'mavis-agent-avatar://default/v1/';
const DEFAULT_AGENT_AVATAR_MARKER_RE = /^mavis-agent-avatar:\/\/default\/v1\/([0-9])$/u;

/** Build the only supported generated-avatar marker (v1 has ten variants). */
export function formatDefaultAgentAvatarMarker(variant: number): string {
  if (!Number.isInteger(variant) || variant < 0 || variant > 9) {
    throw new RangeError('Default Agent avatar variant must be an integer from 0 to 9.');
  }
  return `${DEFAULT_AGENT_AVATAR_MARKER_PREFIX}${variant}`;
}

/**
 * Parse an exact v1 marker. Any ordinary historical avatar value, including a
 * lookalike URL or whitespace-padded marker, intentionally remains unmarked.
 */
export function parseDefaultAgentAvatarMarker(value: string | null | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = DEFAULT_AGENT_AVATAR_MARKER_RE.exec(value);
  return match ? Number(match[1]) : undefined;
}

export function isDefaultAgentAvatarMarker(value: string | null | undefined): boolean {
  return parseDefaultAgentAvatarMarker(value) !== undefined;
}
