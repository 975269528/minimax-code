export interface ClipboardSnapshot {
  readonly text: string;
  readonly html?: string;
}

/**
 * Browser-facing clipboard boundary. Implementations must not assume access
 * to the host operating system clipboard; a provider can be scoped to one
 * evaluation case and restored when that case finishes.
 */
export interface ClipboardProvider {
  read(): Promise<ClipboardSnapshot>;
  write(snapshot: ClipboardSnapshot): Promise<void>;
  snapshot(): Promise<ClipboardSnapshot>;
  restore(snapshot: ClipboardSnapshot): Promise<void>;
}

/**
 * In-memory clipboard used by native-headless evaluation. It deliberately
 * never calls a platform clipboard API, so parallel cases cannot leak text to
 * the developer machine or to one another.
 */
export class IsolatedClipboardProvider implements ClipboardProvider {
  private current: ClipboardSnapshot;

  constructor(initial: Partial<ClipboardSnapshot> = {}) {
    this.current = normalizeSnapshot(initial);
  }

  async read(): Promise<ClipboardSnapshot> {
    return { ...this.current };
  }

  async write(snapshot: ClipboardSnapshot): Promise<void> {
    this.current = normalizeSnapshot(snapshot);
  }

  async snapshot(): Promise<ClipboardSnapshot> {
    return { ...this.current };
  }

  async restore(snapshot: ClipboardSnapshot): Promise<void> {
    this.current = normalizeSnapshot(snapshot);
  }
}

function normalizeSnapshot(snapshot: Partial<ClipboardSnapshot>): ClipboardSnapshot {
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const html = typeof snapshot.html === 'string' ? snapshot.html : undefined;
  return html === undefined ? { text } : { text, html };
}
