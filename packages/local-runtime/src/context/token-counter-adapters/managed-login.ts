import { MANAGED_PROVIDER_API_KEY_PLACEHOLDER } from '../../runtime/model-resolver.js';
import type { RemoteTokenCountContext } from './types.js';

export function isManagedLoginTokenPlan(ctx: RemoteTokenCountContext): boolean {
  if (ctx.apiKey !== MANAGED_PROVIDER_API_KEY_PLACEHOLDER) return false;
  return Object.keys(ctx.headers ?? {}).some((key) => key.toLowerCase() === 'token');
}
