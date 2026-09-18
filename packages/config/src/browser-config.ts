/** Headless Browser runtime configuration shared by local providers. */
export interface BrowserConfig {
  /** Optional Chrome executable path. Omit it to use platform discovery. */
  chromePath?: string;
}

export const BROWSER_CONFIG_DEFAULTS: BrowserConfig = {};

export function parseBrowserConfig(raw: unknown): BrowserConfig {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...BROWSER_CONFIG_DEFAULTS };
  }
  const chromePath = Reflect.get(raw, 'chromePath');
  if (typeof chromePath !== 'string' || !chromePath.trim()) {
    return { ...BROWSER_CONFIG_DEFAULTS };
  }
  return { chromePath: chromePath.trim() };
}
