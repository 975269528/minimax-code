import type { ChalkInstance } from 'chalk';
import type { TuiResolvedAppearance, TuiThemeColors } from './contracts.js';

export type TuiAnsi16ForegroundStyle =
  | 'default'
  | 'defaultDim'
  | 'black'
  | 'blue'
  | 'blueBright'
  | 'cyan'
  | 'cyanBright'
  | 'gray'
  | 'green'
  | 'greenBright'
  | 'magenta'
  | 'magentaBright'
  | 'red'
  | 'redBright'
  | 'white'
  | 'whiteBright'
  | 'yellow'
  | 'yellowBright';

const ANSI16_FOREGROUND_STYLES: Readonly<
  Record<TuiResolvedAppearance, Partial<Record<keyof TuiThemeColors, TuiAnsi16ForegroundStyle>>>
> = Object.freeze({
  dark: Object.freeze({
    brand: 'cyan',
    wordmarkHighlight: 'whiteBright',
    wordmarkShadow: 'cyan',
    signal: 'cyan',
    orbit: 'cyan',
    accent: 'cyan',
    markdownHeading: 'magentaBright',
    markdownCode: 'greenBright',
    markdownLink: 'cyan',
    text: 'default',
    muted: 'defaultDim',
    dim: 'gray',
    border: 'gray',
    line: 'gray',
    success: 'greenBright',
    warning: 'yellowBright',
    error: 'redBright',
  }),
  light: Object.freeze({
    brand: 'blueBright',
    wordmarkHighlight: 'blueBright',
    wordmarkShadow: 'blue',
    signal: 'blueBright',
    orbit: 'cyan',
    accent: 'blueBright',
    markdownHeading: 'magenta',
    markdownCode: 'green',
    markdownLink: 'blue',
    text: 'black',
    muted: 'black',
    dim: 'gray',
    border: 'gray',
    line: 'gray',
    success: 'green',
    warning: 'yellow',
    error: 'red',
  }),
});

export function resolveTuiAnsi16Foreground(
  chalk: ChalkInstance,
  colors: TuiThemeColors,
  appearance: TuiResolvedAppearance,
  color: string,
): ChalkInstance | undefined {
  const normalized = color.toLocaleLowerCase();
  const roles = Object.keys(colors) as (keyof TuiThemeColors)[];
  const role = roles.find((candidate) => colors[candidate].toLocaleLowerCase() === normalized);
  if (!role) return undefined;
  const style = ANSI16_FOREGROUND_STYLES[appearance][role];
  if (style === 'default') return chalk;
  if (style === 'defaultDim') return chalk.dim;
  return style ? chalk[style] : undefined;
}

export function shouldSuppressTuiAnsi16Background(colors: TuiThemeColors, color: string): boolean {
  const normalized = color.toLocaleLowerCase();
  return [colors.userMessageBg, colors.diffAddedBg, colors.diffRemovedBg].some(
    (background) => background.toLocaleLowerCase() === normalized,
  );
}
