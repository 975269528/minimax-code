/**
 * Resolve the `{{DATA_DIR}}` placeholder in prompt / skill file content,
 * mirroring the substitution applied to SKILL.md at registry load time
 * (see @mavis/skills registry.ts). Both the skill file reader and the
 * built-in agent template reader must use the same logic so that any
 * agent-level markdown that references `{{DATA_DIR}}` resolves to the
 * active local-runtime data directory instead of leaking the literal
 * placeholder into the turn prompt.
 *
 * Returns the input unchanged when `MINIMAX_DATA_DIR` is unset or the
 * content has no `{{DATA_DIR}}` marker — this keeps unit tests and
 * callers without an initialized profile working verbatim.
 */
export function resolveDataDirVariables(content: string): string {
  const dataDir = process.env.MINIMAX_DATA_DIR;
  if (!dataDir || !content.includes('{{DATA_DIR}}')) return content;
  const normalizedDir = dataDir.replace(/\\/g, '/');
  return content.split('{{DATA_DIR}}').join(normalizedDir);
}
