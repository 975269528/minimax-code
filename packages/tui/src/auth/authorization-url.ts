// Preserve the attribution value used by the former `/login?sso=1` TUI bridge.
const TUI_DOWNLOAD_SOURCE = 'mcode-internal';

export function markTuiAuthorizationUrl(verificationUrl: string): string {
  try {
    const url = new URL(verificationUrl);
    url.searchParams.set('client_surface', 'tui');
    url.searchParams.set('download_source', TUI_DOWNLOAD_SOURCE);
    return url.toString();
  } catch {
    return verificationUrl;
  }
}
