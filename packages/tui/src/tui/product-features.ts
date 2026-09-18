export interface TuiProductFeatures {
  readonly queue: boolean;
}

export const MINIMAX_CODE_MVP_TUI_PRODUCT_FEATURES: TuiProductFeatures = Object.freeze({
  queue: true,
});

export function resolveTuiProductFeatures(
  overrides: Partial<TuiProductFeatures> | undefined,
): TuiProductFeatures {
  return {
    ...MINIMAX_CODE_MVP_TUI_PRODUCT_FEATURES,
    ...overrides,
  };
}
