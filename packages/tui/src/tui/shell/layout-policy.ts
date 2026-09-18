export type TuiLayoutDensity = 'compact' | 'standard' | 'wide';
export type TuiWelcomeLayout = 'compact' | 'stacked' | 'split';

export interface TuiLayoutPolicy {
  readonly columns: number;
  readonly rows: number;
  readonly density: TuiLayoutDensity;
  readonly welcome: TuiWelcomeLayout;
  readonly horizontalPadding: 0 | 1 | 2;
  readonly transcriptOverscanRows: number;
}

const COMPACT_COLUMNS = 48;
const WIDE_COLUMNS = 72;
const COMPACT_ROWS = 12;

export function resolveTuiLayoutPolicy(columns: number, rows = 24): TuiLayoutPolicy {
  const safeColumns = normalizeDimension(columns);
  const safeRows = normalizeDimension(rows);
  const compact = safeColumns < COMPACT_COLUMNS || safeRows < COMPACT_ROWS;
  const wide = !compact && safeColumns >= WIDE_COLUMNS;
  const density: TuiLayoutDensity = compact ? 'compact' : wide ? 'wide' : 'standard';

  return {
    columns: safeColumns,
    rows: safeRows,
    density,
    welcome: density === 'compact' ? 'compact' : density === 'wide' ? 'split' : 'stacked',
    horizontalPadding: density === 'compact' ? 0 : density === 'wide' ? 2 : 1,
    transcriptOverscanRows: density === 'compact' ? 4 : density === 'wide' ? 12 : 8,
  };
}

function normalizeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}
