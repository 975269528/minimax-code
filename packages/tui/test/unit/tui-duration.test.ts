import { describe, expect, it } from 'vitest';
import { formatTuiDuration } from '../../src/tui/rendering/duration.js';

describe('formatTuiDuration', () => {
  it.each([
    [0, '0s'],
    [-1, '0s'],
    [Number.NaN, '0s'],
    [Number.POSITIVE_INFINITY, '0s'],
    [0.999, '0s'],
    [59.999, '59s'],
    [60, '1min0s'],
    [62, '1min2s'],
    [3_599.999, '59min59s'],
    [3_600, '1h0min0s'],
    [3_601, '1h0min1s'],
    [7_730, '2h8min50s'],
    [7_770, '2h9min30s'],
    [86_461, '24h1min1s'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatTuiDuration(seconds)).toBe(expected);
  });
});
