/**
 * Controls only cold-start execution of state restored from disk. Interactive
 * requests remain enabled in both modes.
 */
export type LocalRuntimeStartupExecutionPolicy = 'enabled' | 'quarantined';

export function isLocalRuntimeStartupExecutionEnabled(
  policy: LocalRuntimeStartupExecutionPolicy | undefined,
): boolean {
  return policy !== 'quarantined';
}
