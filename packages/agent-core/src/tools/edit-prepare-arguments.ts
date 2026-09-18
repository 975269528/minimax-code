/**
 * Shared compatibility shim for the `edit` tool's arguments.
 *
 * Two model-side quirks are normalized before schema validation runs (both
 * mirror Pi 0.79's builtin edit tool shim):
 *
 * 1. Some models (MiniMax-M3 / GLM-5.1) emit `edits` as a JSON string even
 *    though the public schema is `edits[]` — parse it back into an array.
 * 2. Legacy single-edit input (`oldText` / `newText` at the top level) is
 *    folded into `edits[]`.
 *
 * One shared implementation is referenced by all three edit defs
 * (agent-core base, desktop, cloud); edit-defs-contract tests assert the
 * references are identical.
 */

export interface PreparedEditArguments {
  path: string;
  edits: { oldText: string; newText: string }[];
}

export function prepareEditArguments(args: unknown): PreparedEditArguments {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return args as PreparedEditArguments;
  }
  const record = args as Record<string, unknown>;
  let prepared = record;

  if (typeof record.edits === 'string') {
    try {
      const parsed = JSON.parse(record.edits);
      if (Array.isArray(parsed)) {
        prepared = { ...record, edits: parsed };
      }
    } catch {
      // Leave invalid JSON untouched so schema validation reports it normally.
    }
  }

  if (typeof prepared.oldText !== 'string' || typeof prepared.newText !== 'string') {
    return prepared as unknown as PreparedEditArguments;
  }
  const edits = Array.isArray(prepared.edits) ? [...prepared.edits] : [];
  const { oldText: _oldText, newText: _newText, ...rest } = prepared;
  return {
    ...rest,
    edits: [...edits, { oldText: prepared.oldText, newText: prepared.newText }],
  } as PreparedEditArguments;
}
