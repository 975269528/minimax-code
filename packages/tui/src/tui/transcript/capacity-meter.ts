import { tuiChalk as chalk, tuiColors as colors } from '../theme/runtime.js';

export type CapacityMeterTone = 'signal' | 'success' | 'warning' | 'error';

const DEFAULT_BAR_WIDTH = 24;
const MAX_BAR_WIDTH = 64;

export function renderCapacityBar(
  ratioValue: number,
  options: {
    readonly width?: number;
    readonly tone?: CapacityMeterTone;
  } = {},
): string {
  const ratio = clampRatio(ratioValue);
  const width = normalizeBarWidth(options.width);
  const filledWidth = Math.round(ratio * width);
  const paintFilled = chalk.hex(toneColor(options.tone ?? 'signal'));
  const paintEmpty = chalk.hex(colors.line);
  const filled = paintFilled('█'.repeat(filledWidth));
  const empty = paintEmpty('░'.repeat(width - filledWidth));
  return `[${filled}${empty}]`;
}

export function capacityBarWidth(widthValue = DEFAULT_BAR_WIDTH): number {
  return normalizeBarWidth(widthValue) + 2;
}

export function usedCapacityTone(ratioValue: number): CapacityMeterTone {
  const ratio = clampRatio(ratioValue);
  return ratio >= 0.9 ? 'error' : ratio >= 0.7 ? 'warning' : 'signal';
}

export function remainingCapacityTone(ratioValue: number): CapacityMeterTone {
  const ratio = clampRatio(ratioValue);
  return ratio <= 0.2 ? 'error' : ratio <= 0.4 ? 'warning' : 'success';
}

function normalizeBarWidth(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BAR_WIDTH;
  return Math.min(MAX_BAR_WIDTH, Math.max(1, Math.floor(value ?? DEFAULT_BAR_WIDTH)));
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function toneColor(tone: CapacityMeterTone): string {
  if (tone === 'success') return colors.success;
  if (tone === 'warning') return colors.warning;
  if (tone === 'error') return colors.error;
  return colors.signal;
}
