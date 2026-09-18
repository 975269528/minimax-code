export interface TuiBashInput {
  readonly command: string;
  readonly excludeFromContext: boolean;
}

export function parseTuiBashInput(input: string): TuiBashInput | undefined {
  const text = input.trim();
  if (!text.startsWith('!')) return undefined;
  const excludeFromContext = text.startsWith('!!');
  return { command: text.slice(excludeFromContext ? 2 : 1).trim(), excludeFromContext };
}
