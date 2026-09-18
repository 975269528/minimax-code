import type { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { simplifyAssistantContentForTerminal } from '../application/assistant-content.js';
import type { TuiStreamEvent } from '../runtime/stream-events.js';
import { isExecResult, type ExecResult } from './contract.js';
import { ExecEventProjector } from './events.js';
import { TuiExecError } from './exit-policy.js';
import { isReviewResultV1, renderReviewResultText } from '../review/result.js';

export type TuiExecFormat = 'text' | 'json' | 'stream-json';
export type TuiOutputWrite = (value: string) => void | Promise<void>;

export interface TuiHeadlessOutputEncoder {
  event(event: TuiStreamEvent): Promise<void>;
  result(result: ExecResult): Promise<void>;
}

export class HeadlessOutputError extends TuiExecError {
  constructor(message: string, options?: ErrorOptions) {
    super('internal', message, options);
    this.name = 'HeadlessOutputError';
  }
}

export function createHeadlessOutputEncoder(
  format: TuiExecFormat,
  write: TuiOutputWrite,
  options: { readonly eventProjector?: ExecEventProjector } = {},
): TuiHeadlessOutputEncoder {
  let resultSeen = false;
  if (format === 'stream-json' && !options.eventProjector) {
    throw new HeadlessOutputError('stream-json requires an Exec event projector.');
  }

  return {
    async event(event) {
      if (format !== 'stream-json') return;
      for (const projected of options.eventProjector?.project(event) ?? []) {
        await writeSafely(write, `${JSON.stringify(projected)}\n`);
      }
    },
    async result(result) {
      if (resultSeen) throw new HeadlessOutputError('ExecResult was encoded more than once.');
      if (!isExecResult(result)) {
        throw new HeadlessOutputError('Headless coordinator returned an invalid ExecResult.');
      }
      resultSeen = true;
      if (format === 'stream-json') {
        for (const event of options.eventProjector?.complete(result) ?? []) {
          await writeSafely(write, `${JSON.stringify(event)}\n`);
        }
        return;
      }
      if (format === 'json') {
        await writeSafely(write, `${JSON.stringify(result)}\n`);
        return;
      }
      if (result.status === 'succeeded') {
        const text = isReviewResultV1(result.output)
          ? renderReviewResultText(result.output)
          : typeof result.output === 'string'
            ? simplifyAssistantContentForTerminal(result.output)
            : JSON.stringify(result.output);
        await writeSafely(write, `${text ?? ''}\n`);
      }
    },
  };
}

export async function writeHeadlessLastMessage(filePath: string, answer: string): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, answer, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new TuiExecError('internal', `Could not write --output-last-message: ${filePath}`, {
      cause: error,
    });
  }
}

export function createNodeStreamWriter(stream: Writable): TuiOutputWrite {
  return (value) =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        if (error.code === 'EPIPE') {
          reject(new TuiExecError('brokenPipe', 'stdout pipe was closed.', { cause: error }));
          return;
        }
        reject(
          new TuiExecError('internal', `stdout write failed: ${error.message}`, {
            cause: error,
          }),
        );
      };
      stream.once('error', onError);
      try {
        stream.write(value, (error) => {
          if (error) {
            onError(error);
            return;
          }
          if (settled) return;
          settled = true;
          stream.off('error', onError);
          resolve();
        });
      } catch (error) {
        stream.off('error', onError);
        onError(error as NodeJS.ErrnoException);
      }
    });
}

async function writeSafely(write: TuiOutputWrite, value: string): Promise<void> {
  try {
    await write(value);
  } catch (error) {
    if (error instanceof TuiExecError) throw error;
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    throw new TuiExecError(
      code === 'EPIPE' ? 'brokenPipe' : 'internal',
      code === 'EPIPE' ? 'stdout pipe was closed.' : 'stdout writer failed.',
      { cause: error },
    );
  }
}
