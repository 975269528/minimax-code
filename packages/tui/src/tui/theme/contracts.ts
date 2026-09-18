export type TuiResolvedAppearance = 'light' | 'dark';
export type TuiColorLevel = 0 | 1 | 2 | 3;

export type TuiThemeDetectionSource = 'terminal-report' | 'osc11' | 'colorfgbg' | 'fallback';

export interface TuiThemeDetection {
  readonly appearance: TuiResolvedAppearance;
  readonly source: TuiThemeDetectionSource;
  readonly detail: string;
}

export interface TuiThemeColors {
  readonly brand: string;
  readonly wordmarkHighlight: string;
  readonly wordmarkShadow: string;
  readonly signal: string;
  readonly orbit: string;
  readonly accent: string;
  readonly markdownHeading: string;
  readonly markdownCode: string;
  readonly markdownLink: string;
  readonly userMessageBg: string;
  readonly diffAddedBg: string;
  readonly diffRemovedBg: string;
  readonly text: string;
  readonly muted: string;
  readonly dim: string;
  readonly border: string;
  readonly line: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
}

export interface TuiThemePalette {
  readonly id: string;
  readonly appearance: TuiResolvedAppearance;
  readonly colors: TuiThemeColors;
}

export interface TuiThemeSnapshot extends TuiThemeDetection {
  readonly colorLevel: TuiColorLevel;
}
