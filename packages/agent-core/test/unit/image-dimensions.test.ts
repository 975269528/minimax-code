import { describe, expect, it } from 'vitest';

import { imageDimensions } from '../../src/pi-turn-runner/image-dimensions.js';
import {
  BOUNDARY_100X7_JPEG,
  BOUNDARY_100X8_JPEG,
  CORRUPT_TRUNCATED_JPEG,
  EXIF_80X60_JPEG,
  MALFORMED_SHORT_SOF_JPEG,
  NORMAL_40X24_PNG,
  NORMAL_64X48_JPEG,
  THIN_432X2_JPEG,
  UNSUPPORTED_50X50_WEBP,
} from './image-fixtures.js';

describe('imageDimensions', () => {
  it('reads a synthetic thin JPEG header', () => {
    expect(imageDimensions(THIN_432X2_JPEG, 'image/jpeg')).toEqual({ width: 432, height: 2 });
  });

  it('reads a PNG header (TS-9)', () => {
    expect(imageDimensions(NORMAL_40X24_PNG, 'image/png')).toEqual({ width: 40, height: 24 });
  });

  it('reads an ordinary JPEG (TS-11)', () => {
    expect(imageDimensions(NORMAL_64X48_JPEG, 'image/jpeg')).toEqual({ width: 64, height: 48 });
  });

  it('walks the segment chain past EXIF instead of assuming a fixed offset (TS-12)', () => {
    expect(imageDimensions(EXIF_80X60_JPEG, 'image/jpeg')).toEqual({ width: 80, height: 60 });
  });

  it('reads the boundary fixtures used by the outbound projection', () => {
    expect(imageDimensions(BOUNDARY_100X8_JPEG, 'image/jpeg')).toEqual({ width: 100, height: 8 });
    expect(imageDimensions(BOUNDARY_100X7_JPEG, 'image/jpeg')).toEqual({ width: 100, height: 7 });
  });

  it('resolves images whose declared mimeType does not match their bytes', () => {
    // `projectVideoBlocks` turns a `video` block into an `image` block while
    // keeping its `video/*` mimeType, so the bytes have to win.
    expect(imageDimensions(THIN_432X2_JPEG, 'video/mp4')).toEqual({ width: 432, height: 2 });
    expect(imageDimensions(NORMAL_40X24_PNG, 'image/jpeg')).toEqual({ width: 40, height: 24 });
  });

  it.each([
    ['an unsupported format (webp)', UNSUPPORTED_50X50_WEBP, 'image/webp'],
    ['a truncated JPEG', CORRUPT_TRUNCATED_JPEG, 'image/jpeg'],
    ['an empty string', '', 'image/jpeg'],
    ['text that is not base64', '!!!not base64!!!', 'image/jpeg'],
    ['plain text bytes', 'aGVsbG8gd29ybGQ=', 'image/png'],
    ['a missing mimeType', THIN_432X2_JPEG.slice(0, 8), undefined],
    ['a non-string payload', 42, 'image/jpeg'],
    ['a null payload', null, 'image/jpeg'],
    ['an undefined payload', undefined, 'image/jpeg'],
  ])('returns undefined without throwing for %s (TS-13, TS-14)', (_label, data, mimeType) => {
    let result: unknown = 'unset';

    expect(() => {
      result = imageDimensions(data, mimeType);
    }).not.toThrow();

    expect(result).toBeUndefined();
  });

  it('refuses an SOF segment too short to hold its own frame header (TS-31)', () => {
    // Declared segment length 3; the bytes a naive read would use as the size
    // live outside the segment and would fabricate 7x5.
    let result: unknown = 'unset';

    expect(() => {
      result = imageDimensions(MALFORMED_SHORT_SOF_JPEG, 'image/jpeg');
    }).not.toThrow();

    expect(result).toBeUndefined();
  });

  it('does not throw on a JPEG truncated at every prefix length (TS-14)', () => {
    const bytes = Buffer.from(THIN_432X2_JPEG, 'base64');

    for (let length = 0; length <= bytes.length; length += 1) {
      const truncated = bytes.subarray(0, length).toString('base64');
      let result: ReturnType<typeof imageDimensions>;
      expect(() => {
        result = imageDimensions(truncated, 'image/jpeg');
      }).not.toThrow();
      // Either it cannot tell, or it tells the truth. Never a fabricated size.
      if (result !== undefined) expect(result).toEqual({ width: 432, height: 2 });
    }
  });
});
