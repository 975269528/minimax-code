const BLOCK_BYTES = 64;
const UTF8_CHUNK_CODE_UNITS = 8 * 1_024;

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Dependency-free incremental SHA-256 for AgentHost semantic identity.
 * Text is encoded in bounded chunks so hashing one large History string does
 * not allocate another payload-sized Buffer. This is intentionally internal;
 * persistence digests continue to use their owning adapters.
 */
export class IncrementalSha256 {
  private readonly state = new Uint32Array(INITIAL_STATE);
  private readonly block = new Uint8Array(BLOCK_BYTES);
  private readonly schedule = new Uint32Array(64);
  private readonly textEncoder = new TextEncoder();
  private bufferedBytes = 0;
  private totalBytes = 0;
  private finalized = false;

  update(value: string): void {
    if (this.finalized) throw new Error('SHA-256 digest is already finalized.');
    let offset = 0;
    while (offset < value.length) {
      const end = safeUtf8ChunkEnd(value, offset);
      this.updateBytes(this.textEncoder.encode(value.slice(offset, end)));
      offset = end;
    }
  }

  digestHex(): string {
    if (this.finalized) throw new Error('SHA-256 digest is already finalized.');
    this.finalized = true;
    const messageBytes = this.totalBytes;
    this.block[this.bufferedBytes] = 0x80;
    this.bufferedBytes += 1;
    if (this.bufferedBytes > 56) {
      this.block.fill(0, this.bufferedBytes);
      this.compress();
      this.bufferedBytes = 0;
    }
    this.block.fill(0, this.bufferedBytes, 56);
    const messageBits = messageBytes * 8;
    writeUint32BigEndian(this.block, 56, Math.floor(messageBits / 0x1_0000_0000));
    writeUint32BigEndian(this.block, 60, messageBits >>> 0);
    this.compress();
    return [...this.state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }

  private updateBytes(bytes: Uint8Array): void {
    this.totalBytes += bytes.length;
    let offset = 0;
    while (offset < bytes.length) {
      const copied = Math.min(BLOCK_BYTES - this.bufferedBytes, bytes.length - offset);
      this.block.set(bytes.subarray(offset, offset + copied), this.bufferedBytes);
      this.bufferedBytes += copied;
      offset += copied;
      if (this.bufferedBytes !== BLOCK_BYTES) continue;
      this.compress();
      this.bufferedBytes = 0;
    }
  }

  private compress(): void {
    const words = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] =
        (arrayValue(this.block, offset) << 24) |
        (arrayValue(this.block, offset + 1) << 16) |
        (arrayValue(this.block, offset + 2) << 8) |
        arrayValue(this.block, offset + 3);
    }
    for (let index = 16; index < 64; index += 1) {
      const prior15 = arrayValue(words, index - 15);
      const prior2 = arrayValue(words, index - 2);
      const sigma0 = rotateRight(prior15, 7) ^ rotateRight(prior15, 18) ^ (prior15 >>> 3);
      const sigma1 = rotateRight(prior2, 17) ^ rotateRight(prior2, 19) ^ (prior2 >>> 10);
      words[index] =
        (arrayValue(words, index - 16) + sigma0 + arrayValue(words, index - 7) + sigma1) >>> 0;
    }
    this.compressRounds(words);
  }

  private compressRounds(words: Uint32Array): void {
    let a = arrayValue(this.state, 0);
    let b = arrayValue(this.state, 1);
    let c = arrayValue(this.state, 2);
    let d = arrayValue(this.state, 3);
    let e = arrayValue(this.state, 4);
    let f = arrayValue(this.state, 5);
    let g = arrayValue(this.state, 6);
    let h = arrayValue(this.state, 7);
    for (let index = 0; index < 64; index += 1) {
      const upperSigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          upperSigma1 +
          choose +
          arrayValue(ROUND_CONSTANTS, index) +
          arrayValue(words, index)) >>>
        0;
      const upperSigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (upperSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    this.state[0] = (arrayValue(this.state, 0) + a) >>> 0;
    this.state[1] = (arrayValue(this.state, 1) + b) >>> 0;
    this.state[2] = (arrayValue(this.state, 2) + c) >>> 0;
    this.state[3] = (arrayValue(this.state, 3) + d) >>> 0;
    this.state[4] = (arrayValue(this.state, 4) + e) >>> 0;
    this.state[5] = (arrayValue(this.state, 5) + f) >>> 0;
    this.state[6] = (arrayValue(this.state, 6) + g) >>> 0;
    this.state[7] = (arrayValue(this.state, 7) + h) >>> 0;
  }
}

function safeUtf8ChunkEnd(value: string, offset: number): number {
  let end = Math.min(value.length, offset + UTF8_CHUNK_CODE_UNITS);
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (end < value.length && isHighSurrogate(last) && isLowSurrogate(next)) end -= 1;
  return end;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function writeUint32BigEndian(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function arrayValue(values: Uint8Array | Uint32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new RangeError(`SHA-256 array index is out of bounds: ${index}.`);
  return value;
}
