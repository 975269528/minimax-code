import nodePath from 'node:path';
import { shellSourceStages } from '@mavis/agent-runtime';

import type { ToolSourceAdapterInput, ToolSourceReference } from './source-reference.js';

interface GeneratedFileReferenceState {
  readonly references: Map<string, ToolSourceReference>;
  readonly evidence: Map<string, string>;
  readonly generatedFilePaths: Set<string>;
}

export function generatedFilePathsForToolCall(input: ToolSourceAdapterInput): string[] {
  const toolName = normalizeToolName(input.toolName);
  const args = readRecord(input.args);
  if (['write', 'write_file', 'create', 'create_file'].includes(toolName)) {
    const target =
      readNonEmptyString(args?.path) ??
      readNonEmptyString(args?.file_path) ??
      readNonEmptyString(args?.filePath);
    return target ? [resolveGeneratedFilePath(target, input.turn.workspaceDir)] : [];
  }
  if (toolName !== 'bash') return [];

  const command = readNonEmptyString(args?.command);
  if (!command) return [];
  const stages = shellSourceStages(command, input.turn.workspaceDir, resolveShellPath);
  return Array.from(
    new Set(
      stages.flatMap(({ command: stageCommand, directory }) =>
        Array.from(
          stageCommand.matchAll(
            /(?:^|[ \t])(?:\d+)?>{1,2}[ \t]*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s;&|]+))/gmu,
          ),
          (match) => match[1] ?? match[2] ?? match[3] ?? '',
        )
          .map((target) => target.trim())
          .filter((target) => target && !target.startsWith('&'))
          .flatMap((target) => resolveShellPath(target, directory) ?? [])
          .filter((target) => !isTemporaryOrInternalFilePath(target)),
      ),
    ),
  );
}

function resolveShellPath(value: string, directory: string | undefined): string | undefined {
  if (!directory && !nodePath.posix.isAbsolute(value) && !nodePath.win32.isAbsolute(value))
    return undefined;
  return resolveGeneratedFilePath(value, directory ?? '');
}

function resolveGeneratedFilePath(value: string, workingDirectory: string): string {
  if (nodePath.posix.isAbsolute(value) || nodePath.win32.isAbsolute(value)) {
    return normalizeFilePath(value);
  }
  const pathApi = nodePath.win32.isAbsolute(workingDirectory) ? nodePath.win32 : nodePath.posix;
  return normalizeFilePath(pathApi.resolve(workingDirectory, value));
}

function generatedFilePathKey(value: string): string {
  const normalized = normalizeFilePath(value).replace(/:\d+(?::\d+)?$/u, '');
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function isGeneratedFileReference(
  reference: ToolSourceReference,
  generatedFilePaths: ReadonlySet<string>,
): boolean {
  return (
    reference.type === 'file' &&
    Boolean(reference.path) &&
    generatedFilePaths.has(generatedFilePathKey(reference.path ?? ''))
  );
}

export function recordGeneratedFilePaths(
  state: GeneratedFileReferenceState,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  paths.forEach((generatedPath) =>
    state.generatedFilePaths.add(generatedFilePathKey(generatedPath)),
  );
  for (const [citationId, reference] of state.references) {
    if (!isGeneratedFileReference(reference, state.generatedFilePaths)) continue;
    state.references.delete(citationId);
    state.evidence.delete(citationId);
  }
}

/**
 * Office/PDF and other binary attachments are commonly inspected by skill
 * scripts through `bash` because the native read tool cannot decode them. The
 * default adapter accepts only dated v2 asset paths. A local host may also
 * resolve absolute shell paths against its Session-owned attachment registry
 * or workspace boundary; unresolved operands and internal temporary artifacts
 * stay excluded.
 */
export function registeredAssetPathsFromShellCommand(command: string): string[] {
  return Array.from(
    command.matchAll(
      /(?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]*?[\\/]v2[\\/]assets[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^"'`\r\n]*?\.[A-Za-z0-9]{1,16}/gu,
    ),
    (match) => match[0],
  );
}

export function absoluteFilePathsFromShellCommand(command: string): string[] {
  const quoted = Array.from(
    command.matchAll(/(["'])((?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]+?\.[A-Za-z0-9]{1,16})\1/gu),
    (match) => match[2] ?? '',
  );
  const unquoted = Array.from(
    command.matchAll(
      /(?:^|[\s;&|<>])((?:[A-Za-z]:[\\/]|\/)[^\s"'`;&|<>]+?\.[A-Za-z0-9]{1,16})(?=$|[\s;&|<>])/gmu,
    ),
    (match) => match[1] ?? '',
  );
  return Array.from(new Set([...quoted, ...unquoted].filter(Boolean)));
}

export function workspaceFilePathsFromShellCommand(
  command: string,
  workspaceDir: string,
): string[] {
  return Array.from(
    new Set(
      shellSourceStages(command, workspaceDir, resolveShellPath).flatMap(
        ({ command: stageCommand, directory }) =>
          shellFilePathOperands(stageCommand)
            .filter(
              (operand) =>
                nodePath.posix.isAbsolute(operand) ||
                nodePath.win32.isAbsolute(operand) ||
                normalizeFilePath(operand).includes('/'),
            )
            .flatMap((operand) => resolveShellPath(operand, directory) ?? []),
      ),
    ),
  );
}

/**
 * A later shell call often reuses a validated workspace File by basename after
 * changing into the workspace (for example `unzip -p 'report.pptx'`). Match
 * exact resolved identities only; a unique basename is not evidence of identity.
 */
export function knownFileReferencesUsedByShellCommand(
  input: ToolSourceAdapterInput,
  references: Iterable<ToolSourceReference>,
): ToolSourceReference[] {
  if (normalizeToolName(input.toolName) !== 'bash') return [];
  const command = readNonEmptyString(readRecord(input.args)?.command);
  if (!command) return [];
  const knownFiles = Array.from(references).filter(
    (reference): reference is ToolSourceReference & { readonly path: string } =>
      reference.type === 'file' && Boolean(reference.path),
  );
  if (knownFiles.length === 0) return [];

  const operands = shellSourceStages(command, input.turn.workspaceDir, resolveShellPath).flatMap(
    ({ command: stageCommand, directory }) =>
      shellFilePathOperands(stageCommand).flatMap(
        (operand) => resolveShellPath(operand, directory) ?? [],
      ),
  );
  const resolved = operands.flatMap((operand) => {
    const matches = knownFiles.filter(
      (reference) => generatedFilePathKey(operand) === generatedFilePathKey(reference.path),
    );
    if (matches.length !== 1 || !matches[0]) return [];
    return [
      {
        ...matches[0],
        tool_call_id: input.toolCallId,
        tool_name: input.toolName,
        result_path: '$',
      },
    ];
  });
  return Array.from(
    new Map(resolved.map((reference) => [reference.source_id, reference] as const)).values(),
  );
}

function shellFilePathOperands(command: string): string[] {
  const quoted = Array.from(
    command.matchAll(/(["'])((?:\.{0,2}[\\/])?[^"'`\r\n]*?\.[A-Za-z0-9]{1,16})\1/gu),
    (match) => match[2] ?? '',
  );
  const unquoted = Array.from(
    command.matchAll(
      /(?:^|[\s;&|<>])((?:\.{0,2}[\\/])?[^\s"'`;&|<>]+?\.[A-Za-z0-9]{1,16})(?=$|[\s;&|<>])/gmu,
    ),
    (match) => match[1] ?? '',
  );
  return Array.from(
    new Set(
      [...quoted, ...unquoted]
        .map((value) => value.trim())
        .filter(
          (value) =>
            value && !['*', '?', '[', ']', '{', '}', '$'].some((marker) => value.includes(marker)),
        ),
    ),
  );
}

export function normalizeFilePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
}

export function isTemporaryOrInternalFilePath(value: string): boolean {
  const path = normalizeFilePath(value);
  if (/[/\\]v2[/\\]assets[/\\]\d{4}[/\\]\d{2}[/\\]\d{2}[/\\][^/\\]+$/u.test(value)) {
    return false;
  }
  return (
    /(?:^|\/)\.(?:minimax|mavis)(?:-[^/]*)?(?:\/|$)/iu.test(path) ||
    /(?:^|\/)reports\/tool-outputs(?:\/|$)/iu.test(path) ||
    /(?:^|\/)(?:\.tmp|tmp|temp)(?:\/|$)/iu.test(path) ||
    /^\/?(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/iu.test(path) ||
    /(?:^|\/)AppData\/Local\/Temp(?:\/|$)/iu.test(path) ||
    /\.readable\.v\d+\.jsonl$/iu.test(path)
  );
}

export function filePathsMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeFilePath(left).replace(/:\d+(?::\d+)?$/u, '');
  const normalizedRight = normalizeFilePath(right).replace(/:\d+(?::\d+)?$/u, '');
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function normalizeToolName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, '_');
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
