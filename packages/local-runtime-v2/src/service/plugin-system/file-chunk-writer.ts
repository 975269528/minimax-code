interface FileChunkWriter {
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesWritten: number }>;
}

export async function writeFileChunkFully(
  writer: FileChunkWriter,
  chunk: Uint8Array,
  invalidWrite: () => Error,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const remaining = chunk.byteLength - offset;
    const { bytesWritten } = await writer.write(chunk, offset, remaining, null);
    // Retry short writes, but fail immediately on zero progress or out-of-bounds results to prevent infinite loops or corruption.
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw invalidWrite();
    }
    offset += bytesWritten;
  }
}
