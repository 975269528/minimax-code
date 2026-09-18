import type {
  PromptReadSnapshot,
  PromptSnapshotSource,
  PromptTemplateRead,
} from '@mavis/agent-runtime';

import {
  isPromptSnapshotInvalidError,
  type PromptConfigService,
  type PromptFileReader,
  type PromptReadContext,
} from '../prompt-config/index.js';

export interface LocalPromptSnapshotSourceOptions {
  readonly config: Pick<PromptConfigService, 'capture' | 'captureBuiltin'>;
  readonly reader: PromptFileReader;
  /** Complete remote bundle key set; optional local lookup candidates stay missing. */
  readonly managedKeys: ReadonlySet<string>;
}

/**
 * Adapts the local encrypted prompt store to the host-neutral runtime port.
 * The opaque runtime snapshot is only a WeakMap key; prompt storage metadata
 * remains local to this adapter.
 */
export class LocalPromptSnapshotSource implements PromptSnapshotSource {
  private readonly contexts = new WeakMap<PromptReadSnapshot, PromptReadContext>();

  constructor(private readonly options: LocalPromptSnapshotSourceOptions) {}

  async capture(): Promise<PromptReadSnapshot> {
    return this.snapshotFor(await this.options.config.capture());
  }

  async captureBuiltin(): Promise<PromptReadSnapshot> {
    return this.snapshotFor(await this.options.config.captureBuiltin());
  }

  async read(snapshot: PromptReadSnapshot, key: string): Promise<PromptTemplateRead> {
    const context = this.contexts.get(snapshot);
    if (!context) throw new TypeError('Prompt snapshot was not captured by this source.');
    try {
      const content = await this.options.reader.read(context, key);
      if (content !== undefined) return { kind: 'found', content };
      return context.storageMode === 'encrypted' && this.options.managedKeys.has(key)
        ? { kind: 'invalid' }
        : { kind: 'missing' };
    } catch (error) {
      if (context.storageMode === 'encrypted' || isPromptSnapshotInvalidError(error)) {
        return { kind: 'invalid' };
      }
      throw error;
    }
  }

  private snapshotFor(context: PromptReadContext): PromptReadSnapshot {
    const snapshot = Object.freeze({}) as PromptReadSnapshot;
    this.contexts.set(snapshot, context);
    return snapshot;
  }
}
