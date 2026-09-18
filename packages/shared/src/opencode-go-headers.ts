/** Go routes inference by conversation, independently of prompt cache settings. */
export function withOpenCodeGoHeaders(
  baseUrl: string | undefined,
  headers?: Readonly<Record<string, string>>,
  sessionId?: string,
): Record<string, string> | undefined {
  if (!isOpenCodeGoUrl(baseUrl)) return headers ? { ...headers } : undefined;

  const merged = { ...headers };
  for (const name of Object.keys(merged)) {
    if (name.toLowerCase() === 'x-opencode-session' || name.toLowerCase() === 'user-agent') {
      delete merged[name];
    }
  }
  // Runtime identity wins case-insensitively over stale, static config headers.
  // Connectivity requests have no conversation and receive their own identity.
  merged['x-opencode-session'] = sessionId || crypto.randomUUID();
  merged['user-agent'] = 'MiniMaxCode';
  return merged;
}

function isOpenCodeGoUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'opencode.ai' &&
      (url.pathname === '/zen/go' || url.pathname.startsWith('/zen/go/'))
    );
  } catch {
    return false;
  }
}
