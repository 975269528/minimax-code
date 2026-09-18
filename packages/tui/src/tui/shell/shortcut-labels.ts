const DEFAULT_TEXT_MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
};

const MAC_TEXT_MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: 'Ctrl',
  alt: 'Option',
  shift: 'Shift',
  super: 'Command',
};

const TEXT_KEYS: Readonly<Record<string, string>> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
  escape: 'Esc',
  enter: 'Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
};

const MAC_NAMED_KEYS: Readonly<Record<string, string>> = {
  ...NAMED_KEYS,
  home: 'Fn+Left',
  end: 'Fn+Right',
  pageup: 'Fn+Up',
  pagedown: 'Fn+Down',
};

function textModifiers(platform: NodeJS.Platform): Readonly<Record<string, string>> {
  if (platform === 'darwin') return MAC_TEXT_MODIFIERS;
  return DEFAULT_TEXT_MODIFIERS;
}

function namedKeys(platform: NodeJS.Platform): Readonly<Record<string, string>> {
  if (platform === 'darwin') return MAC_NAMED_KEYS;
  return NAMED_KEYS;
}

export function formatTuiShortcut(
  shortcut: string,
  platform: NodeJS.Platform = process.platform,
  termProgram: string | undefined = process.env.TERM_PROGRAM,
): string {
  const parts = shortcut.toLowerCase().split('+');
  let key = parts.pop() ?? '';
  if (key === '/' && parts.includes('ctrl') && !terminalTransmitsCtrlSlash(termProgram)) {
    // macOS Terminal.app has no CSI-u/modifyOtherKeys support and its legacy
    // encoding never transmits Ctrl+/; the 0x1F byte the matcher accepts for
    // this chord is only reachable there via Ctrl+-. Label the chord users
    // can actually press; richer terminals keep the canonical Ctrl+/.
    key = '-';
  }
  const modifiers = textModifiers(platform);
  return [
    ...parts.map((part) => modifiers[part] ?? part),
    TEXT_KEYS[key] ?? namedKeys(platform)[key] ?? key.toUpperCase(),
  ].join('+');
}

export function terminalTransmitsCtrlSlash(
  termProgram: string | undefined = process.env.TERM_PROGRAM,
): boolean {
  return termProgram !== 'Apple_Terminal';
}
