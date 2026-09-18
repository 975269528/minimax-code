import type { MiniAppHostConnectorWritable } from '../../contracts.js';

export class HostConnectorProtocolError extends Error {
  override readonly name = 'HostConnectorProtocolError';
}

/** Strict single-frame NDJSON codec shared by the child and Host halves of the bridge. */
export class StrictNdjsonDecoder {
  private buffer: Buffer;
  private length = 0;
  private ended = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onFrame: (value: unknown) => void,
  ) {
    this.buffer = Buffer.allocUnsafe(Math.min(1024, maxBytes));
  }

  push(chunk: Buffer | string): void {
    if (this.ended) throw new HostConnectorProtocolError('Host Connector stream ended');
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) {
        this.append(bytes.subarray(offset));
        return;
      }
      this.append(bytes.subarray(offset, newline));
      this.takeFrame();
      offset = newline + 1;
      if (offset === bytes.byteLength) return;
    }
  }

  private append(bytes: Buffer): void {
    if (bytes.byteLength === 0) return;
    const required = this.length + bytes.byteLength;
    if (required > this.maxBytes) {
      throw new HostConnectorProtocolError('Host Connector frame exceeds its byte limit');
    }
    this.ensureCapacity(required);
    bytes.copy(this.buffer, this.length);
    this.length = required;
  }

  private ensureCapacity(required: number): void {
    if (required <= this.buffer.byteLength) return;
    const doubled = Math.max(1024, this.buffer.byteLength * 2);
    const next = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(required, doubled)));
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  private takeFrame(): void {
    if (this.length === 0 || this.buffer.subarray(0, this.length).includes(0x0d)) {
      throw new HostConnectorProtocolError('Host Connector frame is invalid');
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(0, this.length)),
      );
    } catch {
      throw new HostConnectorProtocolError('Host Connector frame is not valid JSON');
    }
    this.length = 0;
    this.onFrame(value);
  }

  end(): void {
    this.ended = true;
    if (this.length !== 0) {
      throw new HostConnectorProtocolError('Host Connector stream ended before LF');
    }
  }
}

export function encodeFrame(value: unknown, maxBytes: number): Buffer {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new HostConnectorProtocolError('Host Connector payload is not valid JSON');
  }
  if (json === undefined) {
    throw new HostConnectorProtocolError('Host Connector payload is not valid JSON');
  }
  const frame = Buffer.from(`${json}\n`);
  if (frame.byteLength - 1 > maxBytes) {
    throw new HostConnectorProtocolError('Host Connector frame exceeds its byte limit');
  }
  return frame;
}

export async function writeBytes(
  output: MiniAppHostConnectorWritable,
  bytes: Buffer,
  onWrite?: () => void,
): Promise<void> {
  if (output.destroyed) throw new HostConnectorProtocolError('Host Connector output closed');
  const accepted = output.write(bytes);
  onWrite?.();
  if (accepted) return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      output.removeListener('drain', onDrain);
      output.removeListener('error', onError);
      output.removeListener('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onError = () => finish(new HostConnectorProtocolError('Host Connector write failed'));
    const onClose = () => finish(new HostConnectorProtocolError('Host Connector output closed'));
    output.once('drain', onDrain);
    output.once('error', onError);
    output.once('close', onClose);
  });
}
