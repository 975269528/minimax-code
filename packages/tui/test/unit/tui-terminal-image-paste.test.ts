import { describe, expect, it } from 'vitest';
import {
  getTuiTerminalImagePasteFallbackPath,
  isTuiTerminalImagePaste,
} from '../../src/tui/features/composer/terminal-image-paste.js';

describe('terminal image paste', () => {
  it.each([
    '/tmp/otty-paste/image-123.png',
    '"/var/folders/demo/T/otty-paste/image-123.webp"',
    '/workspace/image-123.avif',
    'C:\\Users\\demo\\AppData\\Local\\Temp\\otty-paste\\image-123.jpg',
    "'D:\\Yingyong\\social\\wechat\\xwechat_files\\wxid_demo\\temp\\RWTemp\\2026-08\\image.png'",
  ])('recognizes pasted absolute image paths: %s', (value) => {
    expect(isTuiTerminalImagePaste(value)).toBe(true);
  });

  it.each([
    'workspace/image-123.png',
    '/tmp/otty-paste/notes.txt',
    '/tmp/otty-paste/image-1.png\nsecond line',
  ])('leaves ordinary pasted text untouched: %s', (value) => {
    expect(isTuiTerminalImagePaste(value)).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)('decodes escaped spaces in %s image paths', (platform) => {
    expect(
      getTuiTerminalImagePasteFallbackPath(
        '/Users/bee/Screen\\ shots/Screenshot\\ 2026-09-17\\ at\\ 18.03.36.png',
        platform,
      ),
    ).toBe('/Users/bee/Screen shots/Screenshot 2026-09-17 at 18.03.36.png');
  });

  it.each([
    ['win32', '/workspace/Screenshot\\ 2026.png'],
    ['darwin', 'C:\\Users\\bee\\ Screenshot.png'],
    ['darwin', '\\\\server\\share\\ Screenshot.png'],
    ['darwin', '//server/share/\\ Screenshot.png'],
    ['darwin', "'/Users/bee/Screenshot\\ 2026.png'"],
    ['darwin', '"/Users/bee/Screenshot\\ 2026.png"'],
    ['darwin', '/Users/bee/Screenshot 2026.png'],
    ['darwin', '/Users/bee/Screenshot\\ 2026.png\nmore text'],
  ] as const)('preserves literal path syntax on %s: %s', (platform, value) => {
    expect(getTuiTerminalImagePasteFallbackPath(value, platform)).toBeUndefined();
  });
});
