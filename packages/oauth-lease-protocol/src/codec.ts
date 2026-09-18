import { AUTH_LEASE_MAX_FRAME_BYTES, AuthLeaseProtocolError } from './contracts.js';

const FRAME_PREFIX_BYTES = 4;

export function encodeAuthLeaseFrame(value: unknown): Buffer {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(value), 'utf8');
  } catch {
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
  }
  if (payload.length === 0 || payload.length > AUTH_LEASE_MAX_FRAME_BYTES) {
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
  }
  const prefix = Buffer.allocUnsafe(FRAME_PREFIX_BYTES);
  prefix.writeUInt32BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

export class AuthLeaseFrameDecoder {
  private buffer = Buffer.alloc(0);

  get bufferedBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Uint8Array): unknown[] {
    if (chunk.byteLength === 0) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: unknown[] = [];

    while (this.buffer.length >= FRAME_PREFIX_BYTES) {
      const payloadLength = this.buffer.readUInt32BE(0);
      if (payloadLength === 0 || payloadLength > AUTH_LEASE_MAX_FRAME_BYTES) {
        this.buffer = Buffer.alloc(0);
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
      }
      const frameLength = FRAME_PREFIX_BYTES + payloadLength;
      if (this.buffer.length < frameLength) {
        if (this.buffer.length > AUTH_LEASE_MAX_FRAME_BYTES + FRAME_PREFIX_BYTES) {
          this.buffer = Buffer.alloc(0);
          throw new AuthLeaseProtocolError('INVALID_REQUEST');
        }
        return frames;
      }
      const payload = this.buffer.subarray(FRAME_PREFIX_BYTES, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      try {
        frames.push(JSON.parse(payload.toString('utf8')) as unknown);
      } catch {
        this.buffer = Buffer.alloc(0);
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
      }
    }
    return frames;
  }
}
