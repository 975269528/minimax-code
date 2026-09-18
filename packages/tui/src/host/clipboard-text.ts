export type TuiTextClipboardWriter = (text: string) => Promise<void>;
export type TuiTextClipboardReader = () => Promise<string | null>;

export async function readTuiClipboardText(): Promise<string | null> {
  const loaded = (await import('@mariozechner/clipboard')) as unknown as {
    getText?: () => Promise<string>;
    default?: { getText?: () => Promise<string> };
  };
  const getText = loaded.getText ?? loaded.default?.getText;
  if (!getText) return null;
  try {
    return (await getText()) || null;
  } catch {
    return null;
  }
}

export async function writeTuiClipboardText(text: string): Promise<void> {
  const loaded = (await import('@mariozechner/clipboard')) as unknown as {
    setText?: (value: string) => Promise<void>;
    default?: { setText?: (value: string) => Promise<void> };
  };
  const setText = loaded.setText ?? loaded.default?.setText;
  if (!setText) throw new Error('The system clipboard text API is unavailable.');
  await setText(text);
}
