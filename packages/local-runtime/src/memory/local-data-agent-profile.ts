import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentDetail } from "@mavis/protocol/local";

export async function isPersonaMissing(args: {
  agentConfigDir: string;
  identityDisplayName: string | undefined;
  builtin: boolean;
  builtinPersona?: string;
}): Promise<{ missing: boolean; personaPath: string }> {
  const personaPath = join(args.agentConfigDir, "PERSONA.md");
  if (args.builtin)
    return { missing: !args.builtinPersona?.trim(), personaPath };
  if (!args.identityDisplayName?.trim()) return { missing: true, personaPath };

  let raw: string;
  try {
    raw = readFileSync(personaPath, "utf-8");
  } catch {
    return { missing: true, personaPath };
  }

  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---/.exec(raw);
  const body = fmMatch
    ? raw.slice(fmMatch[0].length).replace(/^\r?\n/, "")
    : raw;
  if (body.trim().length === 0) return { missing: true, personaPath };

  const normalized = body
    .replace(/[#*_`>\-[\]()!]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { missing: normalized.length < 100, personaPath };
}

export function agentDetailToIdentity(detail: AgentDetail) {
  if (!detail.displayName && !detail.description && !detail.avatar) return null;
  return {
    ...(detail.displayName ? { display_name: detail.displayName } : {}),
    ...(detail.description ? { description: detail.description } : {}),
    ...(detail.avatar ? { avatar: detail.avatar } : {}),
  };
}

export function isBuiltinAgentDetail(detail: AgentDetail): boolean {
  return detail.creationSource === 3;
}

export function toCreationSource(
  value: AgentDetail["creationSource"],
): "manual" | "auto" | "builtin" {
  if (value === 3) return "builtin";
  if (value === 2) return "auto";
  return "manual";
}
