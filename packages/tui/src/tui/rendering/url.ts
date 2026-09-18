import { sanitizeTerminalText } from './terminal-text.js';

/** Remove credentials, query parameters and fragments before rendering a URL. */
export function sanitizeTuiUrl(value: string): string {
  if (value === 'default') return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return sanitizeTerminalText(url.toString().replace(/\/$/u, ''));
  } catch {
    return sanitizeTerminalText(
      (value.split(/[?#]/u, 1)[0] ?? value).replace(/\/\/[^/@\s]+@/gu, '//'),
    );
  }
}
