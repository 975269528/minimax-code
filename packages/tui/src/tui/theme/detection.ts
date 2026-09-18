import type { TuiResolvedAppearance, TuiThemeDetection } from './contracts.js';

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const ANSI_16_COLORS: readonly RgbColor[] = [
  { r: 0, g: 0, b: 0 },
  { r: 128, g: 0, b: 0 },
  { r: 0, g: 128, b: 0 },
  { r: 128, g: 128, b: 0 },
  { r: 0, g: 0, b: 128 },
  { r: 128, g: 0, b: 128 },
  { r: 0, g: 128, b: 128 },
  { r: 192, g: 192, b: 192 },
  { r: 128, g: 128, b: 128 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

export function parseColorFgBgAppearance(
  value: string | undefined,
): TuiResolvedAppearance | undefined {
  if (!value) return undefined;
  const rawIndex = value.split(';').at(-1)?.trim();
  if (!rawIndex || !/^\d{1,3}$/u.test(rawIndex)) return undefined;
  const index = Number(rawIndex);
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  return appearanceFromRgb(ansi256Color(index));
}

export function resolveEnvironmentAppearance(
  env: Readonly<Record<string, string | undefined>>,
): TuiThemeDetection {
  const appearance = parseColorFgBgAppearance(env.COLORFGBG);
  if (appearance) {
    return {
      appearance,
      source: 'colorfgbg',
      detail: `COLORFGBG=${env.COLORFGBG}`,
    };
  }
  return {
    appearance: 'dark',
    source: 'fallback',
    detail: 'no terminal background hint',
  };
}

export function appearanceFromRgb(rgb: RgbColor): TuiResolvedAppearance {
  return relativeLuminance(rgb) >= 0.5 ? 'light' : 'dark';
}

function relativeLuminance(rgb: RgbColor): number {
  const linearize = (channel: number): number => {
    const value = Math.max(0, Math.min(255, channel)) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

function ansi256Color(index: number): RgbColor {
  const basic = ANSI_16_COLORS[index];
  if (basic) return basic;
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return { r: gray, g: gray, b: gray };
  }
  const offset = index - 16;
  const red = Math.floor(offset / 36);
  const green = Math.floor((offset % 36) / 6);
  const blue = offset % 6;
  const channel = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return { r: channel(red), g: channel(green), b: channel(blue) };
}
