import type { PluginHookEffort } from './contracts.js';

const COMPATIBLE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Project a resolved model effort into Compatible's documented Hook shape. */
export function pluginHookEffort(level: string | undefined): PluginHookEffort | undefined {
  return level && COMPATIBLE_EFFORT_LEVELS.has(level)
    ? { level: level as PluginHookEffort['level'] }
    : undefined;
}
