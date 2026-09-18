import {
  ConfigFileError,
  loadConfigFromFile,
  type Config,
  type LoadConfigFromFileOptions,
} from '@mavis/config';

import { TuiExecError } from './exit-policy.js';

export async function loadTuiRuntimeConfig(
  configPath: string,
  options: LoadConfigFromFileOptions,
): Promise<Config> {
  try {
    return loadConfigFromFile(configPath, options);
  } catch (error) {
    const message =
      error instanceof ConfigFileError
        ? error.message
        : `Config is invalid: ${configPath}${error instanceof Error ? ` (${error.message})` : ''}`;
    throw new TuiExecError('config', message, {
      cause: error,
    });
  }
}
