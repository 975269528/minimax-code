import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { parse } from 'yaml';

export const AGENT_CUSTOM_CONFIG_RELATIVE_PATH = 'vela/agent_custom_config.yaml';

export interface LocalAgentCustomConfigEvidence {
  readonly present: boolean;
  applied: boolean;
  readonly rawHash?: string;
  readonly rawBytes?: number;
  errorCount: number;
  readonly errors: string[];
  readonly ignored: string[];
  readonly unsupported: string[];
}

export interface LocalAgentCustomConfigResult {
  readonly evidence: LocalAgentCustomConfigEvidence;
  readonly systemPrompt?: string;
}

export interface LocalAgentCustomConfigLogger {
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export function absentLocalAgentCustomConfigResult(): LocalAgentCustomConfigResult {
  return { evidence: emptyEvidence(false) };
}

/** Reads the Vela-only conversation prompt override without importing v1 Turn code. */
export async function readLocalAgentCustomConfig(input: {
  readonly dataDir: string;
  readonly logger?: LocalAgentCustomConfigLogger;
}): Promise<LocalAgentCustomConfigResult> {
  const filePath = join(input.dataDir, AGENT_CUSTOM_CONFIG_RELATIVE_PATH);
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return absentLocalAgentCustomConfigResult();
    }
    const evidence = withErrors(emptyEvidence(true), [
      `Failed to read ${AGENT_CUSTOM_CONFIG_RELATIVE_PATH}: ${errorMessage(error)}`,
    ]);
    input.logger?.warn({ filePath, customConfig: evidence }, 'agent_custom_config read failed');
    return { evidence };
  }

  const evidence: LocalAgentCustomConfigEvidence = {
    present: true,
    applied: false,
    rawHash: createHash('sha256').update(raw).digest('hex'),
    rawBytes: raw.byteLength,
    errorCount: 0,
    errors: [],
    ignored: [],
    unsupported: [],
  };
  let parsed: unknown;
  try {
    parsed = parse(raw.toString('utf8'));
  } catch (error) {
    const failed = withErrors(evidence, [
      `Failed to parse ${AGENT_CUSTOM_CONFIG_RELATIVE_PATH} as YAML/JSON: ${errorMessage(error)}`,
    ]);
    input.logger?.warn({ filePath, customConfig: failed }, 'agent_custom_config parse failed');
    return { evidence: failed };
  }
  if (!isPlainRecord(parsed)) {
    const failed = withErrors(evidence, [
      `${AGENT_CUSTOM_CONFIG_RELATIVE_PATH} root must be a YAML/JSON object; got ${describeRoot(parsed)}`,
    ]);
    input.logger?.warn({ filePath, customConfig: failed }, 'agent_custom_config root type invalid');
    return { evidence: failed };
  }

  Object.keys(parsed)
    .filter((key) => key !== 'system_prompt')
    .forEach((key) => evidence.unsupported.push(key));
  const systemPrompt = await readSystemPrompt(parsed.system_prompt, evidence);
  evidence.errorCount = evidence.errors.length;
  evidence.applied = typeof systemPrompt === 'string';
  if (evidence.errorCount > 0) {
    input.logger?.warn({ filePath, customConfig: evidence }, 'agent_custom_config apply failed');
  }
  return {
    evidence,
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

async function readSystemPrompt(
  value: unknown,
  evidence: LocalAgentCustomConfigEvidence,
): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    evidence.errors.push('system_prompt must be an object with string content or file');
    return undefined;
  }
  if (Object.hasOwn(value, 'content')) return readInlineSystemPrompt(value, evidence);
  return readFileSystemPrompt(value, evidence);
}

function readInlineSystemPrompt(
  value: Record<string, unknown>,
  evidence: LocalAgentCustomConfigEvidence,
): string | undefined {
  if (typeof value.content !== 'string') {
    evidence.errors.push('system_prompt.content must be a string');
    return undefined;
  }
  if (Object.hasOwn(value, 'file')) evidence.ignored.push('system_prompt.file');
  return value.content;
}

async function readFileSystemPrompt(
  value: Record<string, unknown>,
  evidence: LocalAgentCustomConfigEvidence,
): Promise<string | undefined> {
  if (!Object.hasOwn(value, 'file')) return undefined;
  if (typeof value.file !== 'string' || value.file.trim().length === 0) {
    evidence.errors.push('system_prompt.file must be a non-empty absolute path string');
    return undefined;
  }
  const promptPath = value.file.trim();
  if (!isAbsolute(promptPath)) {
    evidence.errors.push('system_prompt.file must be an absolute path');
    return undefined;
  }
  try {
    return await readFile(promptPath, 'utf8');
  } catch (error) {
    evidence.errors.push(`Failed to read system_prompt.file: ${errorMessage(error)}`);
    return undefined;
  }
}

function emptyEvidence(present: boolean): LocalAgentCustomConfigEvidence {
  return {
    present,
    applied: false,
    errorCount: 0,
    errors: [],
    ignored: [],
    unsupported: [],
  };
}

function withErrors(
  evidence: LocalAgentCustomConfigEvidence,
  errors: readonly string[],
): LocalAgentCustomConfigEvidence {
  evidence.errors.push(...errors);
  evidence.errorCount = evidence.errors.length;
  evidence.applied = false;
  return evidence;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeRoot(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'date';
  const tag = Object.prototype.toString.call(value);
  if (typeof value === 'object' && tag !== '[object Object]') {
    return tag.slice('[object '.length, -1).toLowerCase();
  }
  return typeof value;
}
