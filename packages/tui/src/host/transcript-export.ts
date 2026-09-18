import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface TuiTranscriptExportInput {
  readonly sessionId: string;
  readonly markdown: string;
  readonly exportedAtMs: number;
  readonly outputPath?: string;
  readonly workspaceDirectory?: string;
}

export type TuiTranscriptExporter = (input: TuiTranscriptExportInput) => Promise<string>;

export function createTuiTranscriptExporter(rootDirectory: string): TuiTranscriptExporter {
  return async (input) => {
    const requestedPath = input.outputPath?.trim();
    const fileDirectory = requestedPath
      ? path.dirname(
          path.isAbsolute(requestedPath)
            ? requestedPath
            : path.resolve(input.workspaceDirectory ?? rootDirectory, requestedPath),
        )
      : path.resolve(rootDirectory, 'transcript-exports');
    const directory = path.resolve(fileDirectory);
    await mkdir(directory, { recursive: true });
    const session = safeFileSegment(input.sessionId).slice(0, 48) || 'session';
    const timestamp = new Date(input.exportedAtMs).toISOString().replaceAll(/[:.]/gu, '-');
    for (let sequence = 0; sequence < 100; sequence += 1) {
      const suffix = sequence === 0 ? '' : `-${String(sequence)}`;
      const file = requestedPath
        ? resolveRequestedExportPath(
            requestedPath,
            input.workspaceDirectory ?? rootDirectory,
            suffix,
          )
        : path.join(directory, `${session}-${timestamp}${suffix}.md`);
      try {
        await writeFile(file, input.markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        return file;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
    throw new Error('Unable to allocate a unique Transcript export file.');
  };
}

function resolveRequestedExportPath(
  requestedPath: string,
  workspaceDirectory: string,
  suffix: string,
): string {
  const resolved = path.isAbsolute(requestedPath)
    ? requestedPath
    : path.resolve(workspaceDirectory, requestedPath);
  const extension = path.extname(resolved);
  const base = extension ? resolved.slice(0, -extension.length) : resolved;
  return `${base}${suffix}${extension || '.md'}`;
}

function safeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '');
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
