import type { PromptConfigPointer, PromptReadContext } from '../contracts.js';

const contextKeys = new WeakMap<PromptReadContext, Uint8Array>();

export function createPromptReadContext(
  input: PromptConfigPointer & { readonly scopeId: string; readonly subject: string },
  key?: Uint8Array,
): PromptReadContext {
  const context = Object.freeze({
    scopeId: input.scopeId,
    subject: input.subject,
    version: input.version,
    cacheId: input.cacheId,
    directory: input.directory,
    storageMode: input.storageMode,
    keyVersion: input.keyVersion,
  });
  if (key) contextKeys.set(context, Buffer.from(key));
  return context;
}

export function keyForPromptReadContext(context: PromptReadContext): Uint8Array | undefined {
  return contextKeys.get(context);
}
