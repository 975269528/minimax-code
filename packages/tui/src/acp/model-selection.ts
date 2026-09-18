import type { TuiModel } from '../runtime/port.js';

export function modelSupportsVariant(model: TuiModel, variant: string | undefined): boolean {
  const variants = model.supportedVariants?.length
    ? model.supportedVariants
    : model.variant !== undefined
      ? [model.variant]
      : [];
  return variant === undefined ? variants.length === 0 : variants.includes(variant);
}
