/**
 * Host-neutral prompt template read contracts and bounded internal-turn handoff.
 *
 * Local runtime produces internal model turns while local-runtime-v2 consumes
 * them during preflight. Both packages already depend on agent-core.
 */
declare const promptReadSnapshotBrand: unique symbol;

export interface PromptReadSnapshot {
  readonly [promptReadSnapshotBrand]: never;
}

export type PromptTemplateRead =
  | { readonly kind: 'found'; readonly content: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' };

/** Signals that the enclosing model call must be rebuilt from builtin prompts. */
export class PromptSnapshotInvalidError extends Error {
  override readonly name = 'PromptSnapshotInvalidError';

  constructor(message = 'Prompt snapshot is invalid') {
    super(message);
  }
}

export function isPromptSnapshotInvalidError(error: unknown): error is PromptSnapshotInvalidError {
  return error instanceof PromptSnapshotInvalidError;
}

/** Production hosts own snapshot selection and consumers can only read it. */
export interface PromptSnapshotSource {
  capture(): Promise<PromptReadSnapshot>;
  captureBuiltin(): Promise<PromptReadSnapshot>;
  read(snapshot: PromptReadSnapshot, key: string): Promise<PromptTemplateRead>;
}

/** A host-captured prompt source and immutable snapshot for one model call. */
export interface PromptReadScope {
  readonly source: PromptSnapshotSource;
  readonly snapshot: PromptReadSnapshot;
}

/** Process-local handoff for prompts rendered before an internal Turn is admitted. */
export interface InternalTurnPromptReadRegistry {
  reserve(turnId: string): boolean;
  remember(turnId: string, promptRead: PromptReadScope): void;
  rebind(fromTurnId: string, toTurnId: string): boolean;
  take(turnId: string): PromptReadScope | undefined;
  discard(turnId: string): void;
  close(): void;
}

export class BoundedInternalTurnPromptReadRegistry implements InternalTurnPromptReadRegistry {
  private readonly entries = new Map<string, PromptReadScope>();
  private readonly reservations = new Set<string>();
  private closed = false;

  constructor(private readonly capacity = 128) {}

  reserve(turnId: string): boolean {
    if (this.closed || this.entries.has(turnId) || this.reservations.has(turnId)) return false;
    if (this.entries.size + this.reservations.size >= this.capacity) return false;
    this.reservations.add(turnId);
    return true;
  }

  remember(turnId: string, promptRead: PromptReadScope): void {
    if (this.closed || !this.reservations.delete(turnId)) return;
    this.entries.set(turnId, promptRead);
  }

  rebind(fromTurnId: string, toTurnId: string): boolean {
    if (this.closed) return false;
    const promptRead = this.entries.get(fromTurnId);
    if (!promptRead) return false;
    if (fromTurnId === toTurnId) return true;
    if (this.entries.has(toTurnId) || this.reservations.has(toTurnId)) return false;
    this.entries.delete(fromTurnId);
    this.entries.set(toTurnId, promptRead);
    return true;
  }

  take(turnId: string): PromptReadScope | undefined {
    const promptRead = this.entries.get(turnId);
    this.entries.delete(turnId);
    this.reservations.delete(turnId);
    return promptRead;
  }

  discard(turnId: string): void {
    this.reservations.delete(turnId);
    this.entries.delete(turnId);
  }

  close(): void {
    this.closed = true;
    this.entries.clear();
    this.reservations.clear();
  }
}
