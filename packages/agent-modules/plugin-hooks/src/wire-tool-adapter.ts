import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';

import type { PluginHookCommandHandler, PluginHookEventInput } from './contracts.js';

export function adaptToolIdentity(
  handler: PluginHookCommandHandler,
  event: PluginHookEventInput['event'],
  payload: Readonly<Record<string, unknown>>,
  matcherValue: string | undefined,
  provenance: PluginHookEventInput['toolProvenance'],
  cwd: string,
): {
  readonly toolName: string | undefined;
  readonly toolInput: unknown;
  readonly matcherValue: string | undefined;
} {
  const nativeName = typeof payload.tool_name === 'string' ? payload.tool_name : matcherValue;
  const sourceFormat = handler.sourceFormat;
  const canUseCompatibleIdentity =
    sourceFormat === 'CLAUDE' &&
    (event !== 'PostToolUse' || isRecord(payload.compatible_tool_response)) &&
    isLosslesslyAdaptableCompatibleToolInput(nativeName, payload.tool_input);
  const canUseCodexPatchIdentity =
    sourceFormat === 'CODEX' &&
    (nativeName === 'write' || nativeName === 'edit') &&
    codexApplyPatchCommand(payload.tool_input, nativeName, cwd) !== undefined;
  let toolName = nativeName;
  if (nativeName === 'bash' && (canUseCompatibleIdentity || sourceFormat === 'CODEX'))
    toolName = sourceFormat === 'CLAUDE' && process.platform === 'win32' ? 'PowerShell' : 'Bash';
  else if (nativeName === 'read' && canUseCompatibleIdentity) toolName = 'Read';
  else if (nativeName === 'write' && canUseCompatibleIdentity) toolName = 'Write';
  else if (nativeName === 'edit' && canUseCompatibleIdentity) toolName = 'Edit';
  else if (nativeName === 'task' && canUseCompatibleIdentity) toolName = 'Agent';
  else if (canUseCodexPatchIdentity) toolName = 'apply_patch';
  else if (
    sourceFormat === 'CLAUDE' &&
    canUseCompatibleIdentity &&
    nativeName?.startsWith('mcp__') &&
    provenance?.kind === 'plugin_mcp'
  ) {
    toolName = compatiblePluginMcpToolName(provenance.pluginName, nativeName);
  }
  return {
    toolName,
    matcherValue: toolName,
    toolInput: adaptToolInput(payload.tool_input, nativeName, sourceFormat, cwd),
  };
}

export function restoreNativeToolInput(
  value: Readonly<Record<string, unknown>>,
  handler: PluginHookCommandHandler,
  input: PluginHookEventInput,
): Readonly<Record<string, unknown>> | undefined {
  const nativeName =
    typeof input.payload?.tool_name === 'string' ? input.payload.tool_name : input.matcherValue;
  if (handler.sourceFormat === 'CODEX') {
    if (nativeName === 'write' || nativeName === 'edit') {
      const original = input.payload?.tool_input;
      const originalCommand = codexApplyPatchCommand(original, nativeName, input.cwd);
      if (!originalCommand || !isCommandOnlyBashHookInput(value)) return undefined;
      if (value.command === originalCommand) return isRecord(original) ? original : undefined;
      return restoreCodexApplyPatchInput(value.command, nativeName);
    }
    if (nativeName !== 'bash') return value;
    const original = input.payload?.tool_input;
    if (!isRecord(original) || !isCommandOnlyBashHookInput(value)) return undefined;
    return { ...original, command: value.command };
  }
  if (handler.sourceFormat !== 'CLAUDE') return value;
  if (!isLosslesslyAdaptableCompatibleToolInput(nativeName, input.payload?.tool_input))
    return value;
  if ((nativeName === 'read' || nativeName === 'write') && typeof value.file_path === 'string') {
    if (!isValidCompatibleFileToolInput(nativeName, value)) return undefined;
    const { file_path, ...rest } = value;
    return { path: file_path, ...rest };
  }
  if (nativeName === 'edit')
    return isValidCompatibleFileToolInput(nativeName, value) ? value : undefined;
  if (nativeName === 'bash') {
    if (!isValidCompatibleBashInput(value)) return undefined;
    return value.timeout === undefined
      ? value
      : { ...value, timeout: (value.timeout as number) / 1_000 };
  }
  if (nativeName === 'task') {
    const original = input.payload?.tool_input;
    if (!isRecord(original) || !isValidCompatibleAgentInput(value)) return undefined;
    if (typeof original.agent_name === 'string') {
      const { subagent_type, ...rest } = value;
      return { ...rest, agent_name: subagent_type };
    }
    if (typeof original.subagent_type === 'string') return value;
    return undefined;
  }
  return value;
}

export function isMcpToolInput(input: PluginHookEventInput): boolean {
  const name =
    typeof input.payload?.tool_name === 'string' ? input.payload.tool_name : input.matcherValue;
  return input.toolProvenance?.kind === 'plugin_mcp' || name?.startsWith('mcp__') === true;
}

export function hasCompatibleJsonShape(original: unknown, replacement: unknown): boolean {
  if (original === null || replacement === null) return original === replacement;
  if (Array.isArray(original) || Array.isArray(replacement)) {
    return Array.isArray(original) && Array.isArray(replacement);
  }
  if (isRecord(original) || isRecord(replacement)) {
    if (!isRecord(original) || !isRecord(replacement)) return false;
    const originalKeys = Object.keys(original).sort();
    const replacementKeys = Object.keys(replacement).sort();
    return (
      originalKeys.length === replacementKeys.length &&
      originalKeys.every(
        (key, index) =>
          key === replacementKeys[index] && hasCompatibleJsonShape(original[key], replacement[key]),
      )
    );
  }
  return typeof original === typeof replacement;
}

function adaptToolInput(
  value: unknown,
  nativeName: string | undefined,
  sourceFormat: PluginHookCommandHandler['sourceFormat'],
  cwd: string,
): unknown {
  if (!isRecord(value)) return value;
  if (sourceFormat === 'CODEX') {
    if (nativeName === 'bash' && typeof value.command === 'string') {
      return { command: value.command };
    }
    const command = codexApplyPatchCommand(value, nativeName, cwd);
    return command ? { command } : value;
  }
  if (sourceFormat === 'MINIMAX') return value;
  if (sourceFormat === 'CLAUDE' && !isLosslesslyAdaptableCompatibleToolInput(nativeName, value))
    return value;
  if (nativeName === 'bash' && sourceFormat === 'CLAUDE') {
    if (value.timeout !== undefined && !isFiniteNumber(value.timeout)) return value;
    return value.timeout === undefined ? value : { ...value, timeout: value.timeout * 1_000 };
  }
  if ((nativeName === 'read' || nativeName === 'write') && typeof value.path === 'string') {
    const { path, ...rest } = value;
    return { file_path: resolveHookFilePath(path, cwd), ...rest };
  }
  if (nativeName === 'edit' && typeof value.file_path === 'string') {
    return { ...value, file_path: resolveHookFilePath(value.file_path, cwd) };
  }
  if (nativeName === 'task' && isLosslesslyAdaptableCompatibleToolInput(nativeName, value)) {
    if (typeof value.subagent_type === 'string') return value;
    const { agent_name, ...rest } = value;
    return {
      ...rest,
      ...(typeof agent_name === 'string' ? { subagent_type: agent_name } : {}),
    };
  }
  return value;
}

function codexApplyPatchCommand(
  value: unknown,
  nativeName: string | undefined,
  cwd: string,
): string | undefined {
  if (!isRecord(value)) return undefined;
  if (nativeName === 'write' && isValidNativeWriteInput(value)) {
    const path = resolveHookFilePath(value.path as string, cwd);
    const content = value.content as string;
    return [
      '*** Begin Patch',
      `*** Add File: ${path}`,
      ...content.split('\n').map((line) => `+${line}`),
      '*** End Patch',
    ].join('\n');
  }
  if (nativeName === 'edit' && isValidCompatibleFileToolInput(nativeName, value)) {
    const path = resolveHookFilePath(value.file_path as string, cwd);
    const oldString = value.old_string as string;
    const newString = value.new_string as string;
    return [
      '*** Begin Patch',
      `*** Update File: ${path}`,
      '@@',
      ...oldString.split('\n').map((line) => `-${line}`),
      ...newString.split('\n').map((line) => `+${line}`),
      '*** End Patch',
    ].join('\n');
  }
  return undefined;
}

function restoreCodexApplyPatchInput(
  command: string,
  nativeName: 'write' | 'edit',
): Readonly<Record<string, unknown>> | undefined {
  const lines = command.split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return undefined;
  const body = lines.slice(1, -1);
  const prefix = nativeName === 'write' ? '*** Add File: ' : '*** Update File: ';
  const path = body[0]?.startsWith(prefix) ? body[0].slice(prefix.length) : undefined;
  if (!path || path.includes('\u0000') || path.includes('\n')) return undefined;
  if (nativeName === 'write') {
    const contentLines = body.slice(1);
    if (contentLines.length === 0 || contentLines.some((line) => !line.startsWith('+'))) {
      return undefined;
    }
    return { path, content: contentLines.map((line) => line.slice(1)).join('\n') };
  }
  if (body[1] !== '@@') return undefined;
  const changed = body.slice(2);
  const firstAdded = changed.findIndex((line) => line.startsWith('+'));
  if (firstAdded < 0) return undefined;
  const removed = changed.slice(0, firstAdded);
  const added = changed.slice(firstAdded);
  if (
    removed.length === 0 ||
    removed.some((line) => !line.startsWith('-')) ||
    added.some((line) => !line.startsWith('+'))
  ) {
    return undefined;
  }
  return {
    file_path: path,
    old_string: removed.map((line) => line.slice(1)).join('\n'),
    new_string: added.map((line) => line.slice(1)).join('\n'),
  };
}

function isCommandOnlyBashHookInput(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<{ command: string }> {
  return Object.keys(value).length === 1 && typeof value.command === 'string';
}

function isLosslesslyAdaptableCompatibleToolInput(
  nativeName: string | undefined,
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  if (nativeName === 'bash') return isValidNativeBashInput(value);
  if (nativeName === 'read') return isValidNativeReadInput(value);
  if (nativeName === 'write') return isValidNativeWriteInput(value);
  if (nativeName === 'edit') return isValidCompatibleFileToolInput(nativeName, value);
  if (nativeName !== 'task') return true;
  const desktop = typeof value.agent_name === 'string';
  const cloud = typeof value.subagent_type === 'string';
  if (desktop === cloud) return false;
  const allowed = desktop
    ? new Set(['description', 'prompt', 'agent_name', 'run_in_background'])
    : new Set(['description', 'prompt', 'subagent_type', 'run_in_background']);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidNativeBashInput(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasOnlyKeys(value, ['command', 'timeout', 'run_in_background']) &&
    typeof value.command === 'string' &&
    (value.timeout === undefined || isFiniteNumber(value.timeout)) &&
    (value.run_in_background === undefined || typeof value.run_in_background === 'boolean')
  );
}

function isValidCompatibleBashInput(value: Readonly<Record<string, unknown>>): boolean {
  return isValidNativeBashInput(value);
}

function isValidNativeReadInput(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasOnlyKeys(value, ['path', 'offset', 'limit']) &&
    typeof value.path === 'string' &&
    (value.offset === undefined || isFiniteNumber(value.offset)) &&
    (value.limit === undefined || isFiniteNumber(value.limit))
  );
}

function isValidNativeWriteInput(value: Readonly<Record<string, unknown>>): boolean {
  return (
    hasOnlyKeys(value, ['path', 'content']) &&
    typeof value.path === 'string' &&
    typeof value.content === 'string'
  );
}

function isValidCompatibleFileToolInput(
  nativeName: string,
  value: Readonly<Record<string, unknown>>,
): boolean {
  if (nativeName === 'read') {
    return (
      hasOnlyKeys(value, ['file_path', 'offset', 'limit']) &&
      typeof value.file_path === 'string' &&
      (value.offset === undefined || isFiniteNumber(value.offset)) &&
      (value.limit === undefined || isFiniteNumber(value.limit))
    );
  }
  if (nativeName === 'write') {
    return (
      hasOnlyKeys(value, ['file_path', 'content']) &&
      typeof value.file_path === 'string' &&
      typeof value.content === 'string'
    );
  }
  return (
    nativeName === 'edit' &&
    hasOnlyKeys(value, ['file_path', 'old_string', 'new_string', 'replace_all']) &&
    typeof value.file_path === 'string' &&
    typeof value.old_string === 'string' &&
    typeof value.new_string === 'string' &&
    (value.replace_all === undefined || typeof value.replace_all === 'boolean')
  );
}

export function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidCompatibleAgentInput(value: Readonly<Record<string, unknown>>): boolean {
  const allowed = new Set(['description', 'prompt', 'subagent_type', 'run_in_background']);
  return (
    Object.keys(value).every((key) => allowed.has(key)) &&
    typeof value.description === 'string' &&
    typeof value.prompt === 'string' &&
    typeof value.subagent_type === 'string' &&
    (value.run_in_background === undefined || typeof value.run_in_background === 'boolean')
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function resolveHookFilePath(value: string, cwd: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return resolvePath(homedir(), value.slice(2));
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\')) {
    return value;
  }
  return resolvePath(cwd, value);
}

function compatiblePluginMcpToolName(pluginName: string, nativeName: string): string {
  const suffix = nativeName.slice('mcp__'.length);
  return `mcp__plugin_${pluginName}_${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
