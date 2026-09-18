import { createHash } from 'node:crypto';

const FINGERPRINT_LENGTH = 16;

export interface AssemblyFingerprintContext {
  readonly systemPrompt?: string;
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  }[];
}

export interface AssemblyFingerprint {
  readonly systemPrompt: string;
  readonly tools: string;
}

/**
 * Fingerprint only the provider-visible, cache-relevant assembly surfaces.
 * Message history is intentionally excluded so normal loop growth does not
 * look like system/tool assembly churn.
 */
export function fingerprintAssembly(context: AssemblyFingerprintContext): AssemblyFingerprint {
  const toolInterfaces = (context.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return {
    // Preserve whitespace exactly: prompt caches observe it even when humans do not.
    systemPrompt: fingerprint(context.systemPrompt ?? ''),
    // Preserve tool order but canonicalize object keys inside each definition.
    tools: fingerprint(canonicalStringify(toolInterfaces)),
  };
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, FINGERPRINT_LENGTH);
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set())) ?? 'null';
}

function canonicalize(value: unknown, ancestors: Set<object>): unknown {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Cannot fingerprint cyclic assembly data');
    ancestors.add(value);
    try {
      return value.map((item) => canonicalize(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!value || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new TypeError('Cannot fingerprint cyclic assembly data');

  ancestors.add(value);
  try {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      result[key] = canonicalize(item, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
