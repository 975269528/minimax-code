/** Product-internal tool lifecycle handlers. Custom hooks belong to Plugins. */
export { HookRegistry } from './hook-registry.js';
export type {
  HookHandler,
  HookRegistration,
  HookChainResult,
  Gatable,
  PreToolUseInput,
  PreToolUseOutput,
  PostToolUseInput,
  PostToolUseOutput,
} from './types.js';
export {
  configureHookRegistryHost,
  getMetricsReporter,
  type HookRegistryHostUtils,
  type MetricsReporter,
} from './host-utils.js';
export {
  CU_IMAGE_INJECTOR_ID,
  createCuImageInjectorRegistration,
} from './builtins/cu-image-injector.js';
