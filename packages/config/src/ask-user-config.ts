/**
 * `ask_user` tool switch. Enabled by default; callers may supply a host default, and users may
 * explicitly override it with `askUser.enabled` in `config.yaml`.
 */
export interface AskUserConfig {
  /** Whether to expose the ask_user tool. */
  enabled: boolean;
}

export const ASK_USER_CONFIG_DEFAULTS: AskUserConfig = {
  enabled: true,
};

export function parseAskUserConfig(
  raw: Record<string, unknown>,
  defaults: AskUserConfig = ASK_USER_CONFIG_DEFAULTS,
): AskUserConfig {
  const rawAskUser = raw.askUser;
  if (rawAskUser == null || typeof rawAskUser !== 'object' || Array.isArray(rawAskUser)) {
    return { ...defaults };
  }
  const obj = rawAskUser as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : defaults.enabled,
  };
}
