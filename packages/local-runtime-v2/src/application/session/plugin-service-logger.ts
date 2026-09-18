import type { PluginServiceLogger } from '../../service/plugin-system/index.js';

/** Sink used when a host composes the runtime without a plugin logger. */
const NOOP_PLUGIN_LOGGER: PluginServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function resolvePluginServiceLogger(
  logger: PluginServiceLogger | undefined,
): PluginServiceLogger {
  return logger ?? NOOP_PLUGIN_LOGGER;
}
