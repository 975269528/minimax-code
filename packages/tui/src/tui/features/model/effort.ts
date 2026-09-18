import { normalizeTuiEffortOptions } from '../../../application/model-effort.js';

export {
  normalizeTuiEffortOptions,
  resolveTuiEffortChoice,
  supportsTuiEffort,
} from '../../../application/model-effort.js';

/** `-1` moves toward the lightest level, `1` toward the heaviest. */
export type TuiEffortDirection = -1 | 1;

/**
 * Moves one step inside the configured list and clamps at both ends. Wrapping
 * around would let a single keypress jump between the lightest and heaviest
 * level, which is too easy to trigger by accident.
 */
export function cycleTuiEffort(
  options: readonly string[] | undefined,
  current: string | undefined,
  direction: TuiEffortDirection,
): string | undefined {
  const normalized = normalizeTuiEffortOptions(options);
  if (normalized.length === 0) return undefined;
  const currentIndex = current ? normalized.indexOf(current.trim()) : -1;
  const base = currentIndex >= 0 ? currentIndex : Math.floor(normalized.length / 2);
  const next = Math.min(normalized.length - 1, Math.max(0, base + direction));
  return normalized[next];
}
