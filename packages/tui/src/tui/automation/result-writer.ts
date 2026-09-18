import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isExecResultV1, type ExecResultV1 } from '../../application/exec-result.js';
import { parseTuiStatusLineItems } from '../shell/status-line-items.js';

export const MCODE_TUI_RESULT_PATH_ENV = 'MCODE_TUI_RESULT_PATH';

export interface TuiAutomationResultWriter {
  write(result: ExecResultV1): Promise<void>;
}

export interface CreateTuiAutomationResultWriterOptions {
  readonly statusLineItems?: readonly string[];
  readonly resultPath?: string;
}

/** Enabled only when `build-mode` and a result path are both configured. */
export function createTuiAutomationResultWriter(
  options: CreateTuiAutomationResultWriterOptions,
): TuiAutomationResultWriter | undefined {
  if (
    !options.statusLineItems ||
    !parseTuiStatusLineItems(options.statusLineItems).includes('build-mode')
  ) {
    return undefined;
  }
  const resultPath = options.resultPath?.trim();
  if (!resultPath) return undefined;
  return new JsonLinesTuiAutomationResultWriter(resultPath);
}

class JsonLinesTuiAutomationResultWriter implements TuiAutomationResultWriter {
  private pending: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly writtenTurns = new Set<string>();

  constructor(private readonly resultPath: string) {}

  write(result: ExecResultV1): Promise<void> {
    const write = this.pending.then(async () => {
      await this.initializeWrittenTurns();
      const key = resultKey(result);
      if (this.writtenTurns.has(key)) return;
      await mkdir(path.dirname(this.resultPath), { recursive: true });
      await appendFile(this.resultPath, `${JSON.stringify(result)}\n`, 'utf8');
      this.writtenTurns.add(key);
    });
    this.pending = write.catch(() => undefined);
    return write;
  }

  private async initializeWrittenTurns(): Promise<void> {
    if (this.initialized) return;
    let content = '';
    try {
      content = await readFile(this.resultPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parsed: unknown = JSON.parse(line);
      if (!isExecResultV1(parsed)) {
        throw new Error('The existing TUI automation result file contains an invalid record.');
      }
      this.writtenTurns.add(resultKey(parsed));
    }
    this.initialized = true;
  }
}

function resultKey(result: Pick<ExecResultV1, 'sessionId' | 'turnId'>): string {
  return `${result.sessionId}\u0000${result.turnId}`;
}
