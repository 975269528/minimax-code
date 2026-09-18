import { stripVTControlCharacters } from 'node:util';

export function sanitizeTerminalText(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    '',
  );
}
