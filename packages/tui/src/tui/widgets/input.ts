import { Input as EngineInput, type InputOptions } from '../engine/public.js';

const normalizeSingleLine = (value: string): string =>
  value.replace(/\r\n?|\n/gu, ' ').replace(/\t/gu, '    ');

export class Input extends EngineInput {
  constructor(options: InputOptions = {}) {
    super({
      prompt: '',
      transformPaste: normalizeSingleLine,
      ...options,
    });
  }

  override setValue(value: string): void {
    super.setValue(normalizeSingleLine(value));
  }
}

export type { InputOptions } from '../engine/public.js';
