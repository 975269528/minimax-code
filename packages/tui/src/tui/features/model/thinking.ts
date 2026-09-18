import type { TuiModel } from '../../../runtime/port.js';

export type TuiThinkingChoice = 'on' | 'off';

export function resolveTuiThinkingChoice(model: TuiModel): TuiThinkingChoice | undefined {
  const mode = model.thinkingConfig?.mode;
  if (mode === 'forced_on') return 'on';
  if (mode === 'forced_off') return 'off';
  if (mode !== 'switchable') return undefined;
  if (model.variant === 'thinking') return 'on';
  if (model.variant === '') return 'off';
  return model.thinkingConfig?.defaultValue === 'true' ? 'on' : 'off';
}

export function applyTuiThinkingChoice(model: TuiModel, choice: TuiThinkingChoice): TuiModel {
  if (model.thinkingConfig?.mode !== 'switchable') return model;
  return { ...model, variant: choice === 'on' ? 'thinking' : '' };
}
