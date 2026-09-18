import { Value } from '@sinclair/typebox/value';

import type { RuntimeTool } from './types.js';

/** Revalidates a Hook-rewritten input against the authoritative runtime tool schema. */
export function isRuntimeToolInputValid(
  tools: readonly RuntimeTool[],
  toolName: string,
  value: Readonly<Record<string, unknown>>,
): boolean {
  const tool = tools.find((candidate) => candidate.def.name === toolName);
  return Boolean(tool && Value.Check(tool.def.schema, value));
}
