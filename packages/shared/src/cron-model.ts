/** Versioned Cron model configuration stored in the existing model TEXT field. */
export interface CronModelSelection {
  readonly providerID: string;
  readonly modelID: string;
  readonly variant?: string;
  readonly thinking?: { readonly effort?: string };
  readonly contextLimit?: number;
}

export interface DecodedCronModel {
  readonly modelKey: string;
  /** Absent for legacy model keys/aliases; their existing parameter policy is preserved. */
  readonly selection?: CronModelSelection;
}

function invalid(): never {
  throw new Error('Invalid scheduled task model configuration');
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return invalid();
  return value.trim();
}

export function decodeCronModel(value: string): DecodedCronModel {
  const trimmed = value.trim();
  if (!trimmed) return invalid();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { modelKey: trimmed };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return invalid();
  }
  const input = record(parsed);
  if (input.version !== 1) return invalid();
  const providerID = requiredText(input.providerID);
  const modelID = requiredText(input.modelID);
  if (providerID.includes('/')) return invalid();
  if (input.variant !== undefined && typeof input.variant !== 'string') return invalid();
  if (
    input.contextLimit !== undefined &&
    (typeof input.contextLimit !== 'number' ||
      !Number.isSafeInteger(input.contextLimit) ||
      input.contextLimit <= 0)
  )
    return invalid();
  let thinking: CronModelSelection['thinking'];
  if (input.thinking !== undefined) {
    const thinkingInput = record(input.thinking);
    thinking =
      thinkingInput.effort === undefined ? {} : { effort: requiredText(thinkingInput.effort) };
  }
  const selection: CronModelSelection = {
    providerID,
    modelID,
    ...(input.variant !== undefined ? { variant: input.variant as string } : {}),
    ...(thinking ? { thinking } : {}),
    ...(input.contextLimit !== undefined ? { contextLimit: input.contextLimit as number } : {}),
  };
  return { modelKey: `${providerID}/${modelID}`, selection };
}

export function encodeCronModel(selection: CronModelSelection): string {
  // Validate the same wire shape at both boundaries; only supported fields are persisted.
  const decoded = decodeCronModel(JSON.stringify({ version: 1, ...selection }));
  return JSON.stringify({ version: 1, ...decoded.selection });
}
