export const MINIMAX_CODE_DEFAULT_AGENT_NAME = 'mavis';

export interface TuiProductContext {
  surface: 'cli' | 'tui' | 'headless';
  defaultAgentName: string;
}

export function createTuiProductContext(
  surface: TuiProductContext['surface'],
  overrides: Partial<Pick<TuiProductContext, 'defaultAgentName'>> = {},
): TuiProductContext {
  return {
    surface,
    defaultAgentName: overrides.defaultAgentName ?? MINIMAX_CODE_DEFAULT_AGENT_NAME,
  };
}
