import type { McodeUpdatePlan } from './application.js';

export interface McodeStartupUpdateNotice {
  readonly latestVersion: string;
}

export function resolveMcodeStartupUpdateNotice(
  plan: McodeUpdatePlan,
): McodeStartupUpdateNotice | undefined {
  if (plan.kind !== 'available' && plan.kind !== 'package-manager') return undefined;
  const latestVersion = plan.latestVersion.trim();
  return latestVersion ? { latestVersion } : undefined;
}
