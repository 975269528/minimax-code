import fs from 'node:fs';
import yaml from 'js-yaml';

import { prepareConfigFileForRead, resolveConfigFromRaw, type Config } from './config.js';

export type ConfigFileErrorCode =
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_PARSE_FAILED'
  | 'CONFIG_ROOT_INVALID';

export class ConfigFileError extends Error {
  readonly code: ConfigFileErrorCode;
  readonly configPath: string;

  constructor(
    code: ConfigFileErrorCode,
    configPath: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ConfigFileError';
    this.code = code;
    this.configPath = configPath;
  }
}

export interface LoadConfigFromFileOptions {
  dataDir: string;
}

function readConfigDocument(configPath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (cause) {
    throw new ConfigFileError(
      'CONFIG_READ_FAILED',
      configPath,
      `Cannot read config ${configPath}.`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (cause) {
    throw new ConfigFileError(
      'CONFIG_PARSE_FAILED',
      configPath,
      `Config is not valid YAML: ${configPath}`,
      { cause },
    );
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigFileError(
      'CONFIG_ROOT_INVALID',
      configPath,
      `Config root must be an object: ${configPath}`,
    );
  }

  return parsed as Record<string, unknown>;
}

export function loadConfigFromFile(configPath: string, options: LoadConfigFromFileOptions): Config {
  if (fs.existsSync(configPath)) prepareConfigFileForRead(configPath);

  return resolveConfigFromRaw(readConfigDocument(configPath), options.dataDir);
}

export function readExplicitBetaFeatureFromFile(
  configPath: string,
  feature: keyof Config['beta'],
): boolean | undefined {
  const raw = readConfigDocument(configPath);
  if (raw.beta == null || typeof raw.beta !== 'object' || Array.isArray(raw.beta)) {
    return undefined;
  }
  const configured = (raw.beta as Record<string, unknown>)[feature];
  return typeof configured === 'boolean' ? configured : undefined;
}
