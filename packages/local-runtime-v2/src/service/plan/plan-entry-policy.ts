export interface PlanEntryFeatureConfig {
  readonly desktopPlanMode?: boolean;
  readonly desktopPlanModeAgentEntry?: boolean;
}

export interface PlanEntryPolicy {
  readonly manualEntryEnabled: boolean;
  readonly agentEntryEnabled: boolean;
}

export function resolvePlanEntryPolicy(beta: PlanEntryFeatureConfig | undefined): PlanEntryPolicy {
  const manualEntryEnabled = beta?.desktopPlanMode !== false;
  return {
    manualEntryEnabled,
    agentEntryEnabled: manualEntryEnabled && beta?.desktopPlanModeAgentEntry === true,
  };
}

export function createPlanEntryReaders(
  config: () => { beta?: Parameters<typeof resolvePlanEntryPolicy>[0] },
) {
  return {
    planEntryEnabled: () => resolvePlanEntryPolicy(config().beta).manualEntryEnabled,
    agentPlanEntryEnabled: () => resolvePlanEntryPolicy(config().beta).agentEntryEnabled,
  };
}
