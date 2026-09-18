import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { redactTuiSensitiveText } from '../user-facing-failure.js';

const ANSWER_LIMIT = 256 * 1024;
const EVENT_LIMIT = 4 * 1024 * 1024;
const FLUSH_TIMEOUT_MS = 5_000;

function redactDiagnosticText(value: string): string {
  // Failed JSON cannot be parsed safely. Match quoted credential fields as text,
  // including escaped quotes, before applying the shared free-text redactor.
  return redactTuiSensitiveText(
    value.replace(
      /("(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret)"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
      '$1"[redacted]"',
    ),
  );
}

function boundedAnswer(value: Buffer): Buffer {
  if (value.length <= ANSWER_LIMIT) return value;
  const marker = Buffer.from('\n[diagnostic answer truncated: middle omitted]\n');
  const half = Math.floor((ANSWER_LIMIT - marker.length) / 2);
  let headEnd = half;
  let tailStart = value.length - half;
  // Do not cut inside a UTF-8 code point at either retained boundary.
  while (((value[headEnd] ?? 0) & 0xc0) === 0x80) headEnd -= 1;
  while (((value[tailStart] ?? 0) & 0xc0) === 0x80) tailStart += 1;
  return Buffer.concat([value.subarray(0, headEnd), marker, value.subarray(tailStart)]);
}

export async function prepareDiagnosticsDirectory(
  path: string,
  workspace: string,
): Promise<string> {
  const directory = resolve(workspace, path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Diagnostics path must be a real directory.');
  await access(directory, constants.W_OK);
  if ((await readdir(directory)).length > 0)
    throw new Error('Diagnostics directory must be empty.');
  return directory;
}

export function outputSchemaHash(
  schema: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  return schema ? createHash('sha256').update(JSON.stringify(schema)).digest('hex') : undefined;
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret)$/iu.test(
          key,
        )
          ? '[redacted]'
          : sanitize(item),
      ]),
    );
  }
  return value;
}

/** A bounded, file-only sink. Callers must pass metadata, never raw runtime events. */
export class ExecDiagnostics {
  private pending: Promise<void> = Promise.resolve();
  private bytes = 0;
  private droppedEvents = 0;
  private closed = false;
  private failed = false;

  private constructor(
    private readonly directory: string,
    private readonly warn: (message: string) => void,
    private readonly progressFile: FileHandle,
  ) {}

  static async create(
    directory: string,
    warn: (message: string) => void,
  ): Promise<ExecDiagnostics> {
    // Refuse reuse rather than overwrite an earlier attempt's evidence.
    if ((await readdir(directory)).length > 0) {
      throw Object.assign(new Error('Diagnostics directory must be empty.'), { code: 'EEXIST' });
    }
    const marker = await open(join(directory, 'progress.jsonl'), 'wx', 0o600);
    return new ExecDiagnostics(directory, warn, marker);
  }

  record(event: Readonly<Record<string, unknown>>): void {
    if (this.closed) return;
    const line = `${JSON.stringify(sanitize({ timestampMs: Date.now(), ...event }))}\n`;
    const length = Buffer.byteLength(line);
    if (this.bytes + length > EVENT_LIMIT) {
      this.droppedEvents += 1;
      return;
    }
    this.bytes += length;
    this.enqueue(() => this.progressFile.appendFile(line));
  }

  execution(metadata: Readonly<Record<string, unknown>>): void {
    this.json('execution.json', { schemaVersion: 1, ...metadata });
  }

  failure(answer: string | null | undefined, metadata: Readonly<Record<string, unknown>>): void {
    const redacted = Buffer.from(redactDiagnosticText(answer ?? ''));
    const truncated = redacted.length > ANSWER_LIMIT;
    const saved = boundedAnswer(redacted);
    this.json('failure.json', {
      schemaVersion: 1,
      ...metadata,
      answerBytes: Buffer.byteLength(answer ?? ''),
      savedBytes: saved.length,
      truncated,
      redacted: true,
    });
    this.enqueue(() => this.replaceFile('failure-answer.txt', saved));
  }

  async flush(summary: Readonly<Record<string, unknown>> = {}): Promise<boolean> {
    this.enqueue(async () => {
      const [entry, opened] = await Promise.all([
        lstat(join(this.directory, 'progress.jsonl')),
        this.progressFile.stat(),
      ]);
      if (!entry.isFile() || entry.ino !== opened.ino || entry.dev !== opened.dev) {
        throw new Error('Diagnostics progress file was replaced.');
      }
    });
    this.enqueue(() => this.progressFile.close());
    this.enqueue(() =>
      this.replaceFile(
        'diagnostics-status.json',
        `${JSON.stringify(
          sanitize({
            ...summary,
            recoveryReady: summary.recoveryReady === true && !this.failed,
            diagnosticsComplete: !this.failed,
            droppedEventCount: this.droppedEvents,
          }),
          null,
          2,
        )}\n`,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      this.pending.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), FLUSH_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.closed = true;
    if (!completed) this.reportFailure('diagnostics flush deadline exceeded');
    // Release the handle after any in-flight append, without extending flush's deadline.
    void this.pending.finally(() => this.progressFile.close()).catch(() => undefined);
    return completed && !this.failed;
  }

  private json(name: string, value: Readonly<Record<string, unknown>>): void {
    const body = `${JSON.stringify(sanitize(value), null, 2)}\n`;
    this.enqueue(() => this.replaceFile(name, body));
  }

  private async replaceFile(name: string, body: string | Buffer): Promise<void> {
    const temporary = join(this.directory, `.${name}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
      // Replaces the directory entry, never follows a substituted file symlink.
      if (!this.closed) await rename(temporary, join(this.directory, name));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private enqueue(write: () => Promise<unknown>): void {
    if (this.closed) return;
    this.pending = this.pending
      .then(async () => {
        if (!this.closed) await write();
      })
      .catch(() => this.reportFailure('could not write execution diagnostics'));
  }

  private reportFailure(message: string): void {
    if (!this.failed) this.warn(`mcode diagnostics warning: ${message}\n`);
    this.failed = true;
  }
}
