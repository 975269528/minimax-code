import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const GLOBAL_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

export type GlobalInstructionsErrorCode =
  | 'GLOBAL_INSTRUCTIONS_READ_FAILED'
  | 'GLOBAL_INSTRUCTIONS_TOO_LARGE'
  | 'GLOBAL_INSTRUCTIONS_WRITE_FAILED';

export class GlobalInstructionsError extends Error {
  override readonly name = 'GlobalInstructionsError';

  constructor(readonly code: GlobalInstructionsErrorCode) {
    super(code);
  }
}

export interface GlobalInstructionsState {
  readonly content: string;
  readonly exists: boolean;
  readonly maxBytes: number;
}

/** Turn-owned access to the profile-wide AGENTS.md file. */
export class GlobalInstructions {
  private readonly filePath: string;

  constructor(private readonly dataDir: string) {
    this.filePath = resolve(dataDir, 'AGENTS.md');
  }

  async read(): Promise<GlobalInstructionsState> {
    try {
      return {
        content: await readFile(this.filePath, 'utf8'),
        exists: true,
        maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return emptyState();
      throw new GlobalInstructionsError('GLOBAL_INSTRUCTIONS_READ_FAILED');
    }
  }

  async readForPrompt(): Promise<string | undefined> {
    try {
      if ((await stat(this.filePath)).size > GLOBAL_INSTRUCTIONS_MAX_BYTES) return undefined;
      const content = await readFile(this.filePath, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > GLOBAL_INSTRUCTIONS_MAX_BYTES) return undefined;
      return content.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async write(content: string): Promise<GlobalInstructionsState> {
    if (Buffer.byteLength(content, 'utf8') > GLOBAL_INSTRUCTIONS_MAX_BYTES) {
      throw new GlobalInstructionsError('GLOBAL_INSTRUCTIONS_TOO_LARGE');
    }
    if (!content.trim()) {
      try {
        await unlink(this.filePath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
          throw new GlobalInstructionsError('GLOBAL_INSTRUCTIONS_WRITE_FAILED');
        }
      }
      return emptyState();
    }

    let tempPath: string | undefined;
    try {
      await mkdir(this.dataDir, { recursive: true });
      tempPath = join(
        this.dataDir,
        `.global-instructions-tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
      );
      const handle = await open(tempPath, 'wx', 0o600);
      try {
        await handle.writeFile(content, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
      tempPath = undefined;
      return { content, exists: true, maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES };
    } catch {
      if (tempPath) await removeTempFileBestEffort(tempPath);
      throw new GlobalInstructionsError('GLOBAL_INSTRUCTIONS_WRITE_FAILED');
    }
  }
}

async function removeTempFileBestEffort(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The stable write error remains authoritative after best-effort cleanup.
  }
}

function emptyState(): GlobalInstructionsState {
  return { content: '', exists: false, maxBytes: GLOBAL_INSTRUCTIONS_MAX_BYTES };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
