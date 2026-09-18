import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __IS_NPM_BUILD__: boolean | undefined;

/** Source and dist both retain the runtime hierarchy; the npm bundle's module URL is fixed to the package entry point. */
export function resolveTuiReviewPromptDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return typeof __IS_NPM_BUILD__ !== 'undefined' && __IS_NPM_BUILD__
    ? resolve(here, 'assets/prompts/code-review')
    : resolve(here, '../../../local-runtime/assets/prompts/code-review');
}
