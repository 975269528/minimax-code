import { digestSafetyInput } from '../../content-safety/index.js';

export function digestTurnInput(input: unknown, clientIntent?: string): string {
  const identity = clientIntent === undefined ? input : { input, clientIntent };
  return digestSafetyInput(identity);
}
