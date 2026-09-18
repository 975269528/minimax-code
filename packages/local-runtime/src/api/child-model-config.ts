export interface ChildModelSelectionInput {
  taskModelConfigId?: string | null;
  teamDefaultModelConfigId?: string | null;
  parentEffectiveModel?: string | null;
  parentEffectiveModelVariant?: string | null;
}

export interface ChildModelSelection {
  effectiveModel?: string;
  effectiveModelVariant?: string;
}

export function resolveChildModelSelection(input: ChildModelSelectionInput): ChildModelSelection {
  const taskModel = normalizeModelConfigId(input.taskModelConfigId);
  const teamDefault = normalizeModelConfigId(input.teamDefaultModelConfigId);
  const parentModel = normalizeModelConfigId(input.parentEffectiveModel);
  const effectiveModel = taskModel ?? teamDefault ?? parentModel;
  if (!effectiveModel) return {};
  const inheritedVariant =
    effectiveModel === parentModel ? (input.parentEffectiveModelVariant ?? undefined) : undefined;
  return {
    effectiveModel,
    ...(inheritedVariant ? { effectiveModelVariant: inheritedVariant } : {}),
  };
}

function normalizeModelConfigId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
