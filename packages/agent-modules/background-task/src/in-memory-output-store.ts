import type {
  TaskOutputChunk,
  TaskOutputKind,
  TaskOutputReadOptions,
  TaskOutputReadResult,
  TaskOutputRef,
  TaskOutputStore,
  TaskOutputStream,
} from './types.js';

export interface InMemoryTaskOutputStoreOptions {
  now?: () => number;
  kind?: TaskOutputKind;
  uriPrefix?: string;
}

interface OutputRecord {
  chunks: TaskOutputChunk[];
  summary?: string;
  outputRef?: TaskOutputRef;
}

export class InMemoryTaskOutputStore implements TaskOutputStore {
  private readonly outputs = new Map<string, OutputRecord>();
  private readonly now: () => number;
  private readonly kind: TaskOutputKind;
  private readonly uriPrefix: string;

  constructor(options: InMemoryTaskOutputStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.kind = options.kind ?? 'memory';
    this.uriPrefix = options.uriPrefix ?? 'memory://background-task/';
  }

  async append(chunk: TaskOutputChunk): Promise<TaskOutputRef> {
    const record = this.getOrCreate(chunk.taskId);
    const stream = chunk.stream ?? 'stdout';
    const offset = chunk.offset ?? byteLength(this.getContent(chunk.taskId, stream));
    const storedChunk: TaskOutputChunk = {
      ...chunk,
      stream,
      offset,
      timestamp: chunk.timestamp ?? this.now(),
      metadata: chunk.metadata ? { ...chunk.metadata } : undefined,
    };
    record.chunks.push(storedChunk);

    const outputRef: TaskOutputRef = {
      taskId: chunk.taskId,
      kind: this.kind,
      uri: `${this.uriPrefix}${encodeURIComponent(chunk.taskId)}`,
      offset: offset + byteLength(chunk.content),
      updatedAt: storedChunk.timestamp,
    };
    record.outputRef = outputRef;
    return { ...outputRef };
  }

  async read(taskId: string, options: TaskOutputReadOptions = {}): Promise<TaskOutputReadResult> {
    const record = this.outputs.get(taskId);
    if (!record) {
      return { content: '', nextOffset: options.offset ?? 0, outputRef: undefined };
    }

    const stream = options.stream;
    const offset = Math.max(0, options.offset ?? 0);
    const content = this.getContent(taskId, stream);
    const limit = options.limitBytes;
    const slice = sliceUtf8(content, offset, limit);

    return {
      content: slice.content,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      summary: record.summary,
      outputRef: record.outputRef ? { ...record.outputRef } : undefined,
    };
  }

  async tail(taskId: string, limitBytes = 8_192): Promise<TaskOutputReadResult> {
    const content = this.getContent(taskId);
    const offset = Math.max(0, byteLength(content) - limitBytes);
    return this.read(taskId, { offset, limitBytes });
  }

  async finalize(taskId: string, summary?: string): Promise<void> {
    const record = this.getOrCreate(taskId);
    record.summary = summary;
  }

  private getOrCreate(taskId: string): OutputRecord {
    let record = this.outputs.get(taskId);
    if (!record) {
      record = { chunks: [] };
      this.outputs.set(taskId, record);
    }
    return record;
  }

  private getContent(taskId: string, stream?: TaskOutputStream): string {
    const record = this.outputs.get(taskId);
    if (!record) return '';
    return record.chunks
      .filter((chunk) => !stream || (chunk.stream ?? 'stdout') === stream)
      .map((chunk) => chunk.content)
      .join('');
  }
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

function sliceUtf8(
  content: string,
  offset: number,
  limitBytes: number | undefined,
): { content: string; nextOffset: number; truncated: boolean } {
  const buffer = Buffer.from(content, 'utf8');
  const start = Math.min(offset, buffer.length);
  const end =
    limitBytes === undefined ? buffer.length : Math.min(buffer.length, start + limitBytes);

  return {
    content: buffer.subarray(start, end).toString('utf8'),
    nextOffset: end,
    truncated: end < buffer.length,
  };
}
