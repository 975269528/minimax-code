import type { PromptSnapshotSource } from '@mavis/agent-runtime';

/**
 * Resolves one complete model prompt from a single captured snapshot. A remote
 * read failure restarts this prompt from the builtin snapshot, never mixing
 * remote and builtin fragments in the same model request.
 */
export async function readPromptWithBuiltinFallback(input: {
  readonly source?: PromptSnapshotSource;
  readonly key: string;
  readonly builtin: string;
}): Promise<string> {
  if (!input.source) return input.builtin;
  const snapshot = await input.source.capture();
  const current = await input.source.read(snapshot, input.key);
  if (current.kind === 'found') return current.content;
  if (current.kind === 'missing') return input.builtin;

  const builtinSnapshot = await input.source.captureBuiltin();
  const fallback = await input.source.read(builtinSnapshot, input.key);
  return fallback.kind === 'found' ? fallback.content : input.builtin;
}
