import { Buffer, constants as bufferConstants } from 'node:buffer';
import { createReadStream, openSync, readSync, closeSync } from 'node:fs';

import {
  isLocalSessionLedgerEvent,
  type LocalSessionLedgerEvent,
  type LocalSessionLedgerWatermark,
} from './ledger-event.js';

export interface ParsedLedgerEventWithOffset {
  event: LocalSessionLedgerEvent;
  byteOffset: number;
}

/**
 * Hard cap on a single JSONL line we are willing to materialize into a JS
 * string. A line larger than this is treated as a pathological/corrupt event
 * and skipped (its bytes are still counted so downstream byte offsets stay
 * correct), letting the scan recover and keep reading subsequent events.
 *
 * A representable V8 string can encode to at most three UTF-8 bytes per UTF-16
 * code unit. Keep every line the existing JS writer can produce, bounded by
 * Node's Buffer limit, and skip only lines that cannot be materialized here.
 */
export const MAX_LEDGER_LINE_BYTES = Math.min(
  bufferConstants.MAX_LENGTH,
  bufferConstants.MAX_STRING_LENGTH * 3,
);

const NEWLINE_BYTE = 0x0a;

export function compareLedgerEvents(
  left: LocalSessionLedgerEvent,
  right: LocalSessionLedgerEvent,
): number {
  return left.seq - right.seq || left.eventId.localeCompare(right.eventId);
}

/** True for V8's `String::kMaxLength` overflow (0x1fffffe8, ~512MB). */
export function isStringLengthOverflowError(err: unknown): boolean {
  return err instanceof RangeError && /string longer than/i.test(err.message);
}

/**
 * A single ledger line spanning byte range `[lineStartOffset, byteOffset)`.
 * `bytes` is the decoded line buffer when the line is within
 * `MAX_LEDGER_LINE_BYTES`; when it exceeds the cap, `oversized` is true and
 * `bytes` is undefined (we never materialized it). `byteOffset` is the
 * cumulative offset through the trailing newline (matching the historical
 * offset semantics), regardless of oversized.
 */
interface RawLedgerLine {
  bytes?: Buffer;
  byteOffset: number;
  oversized: boolean;
}

/**
 * Byte-level line splitter shared by the async streaming reader and the sync
 * scanners. It accumulates raw bytes, emits one `RawLedgerLine` per newline,
 * and — crucially — when a single line exceeds `MAX_LEDGER_LINE_BYTES` it drops
 * that line's bytes (keeping only a running byte count) and RESUMES at the next
 * newline. This makes a single pathological giant event fail-open: the line is
 * skipped, but every following event still parses. Nothing here ever builds a
 * JS string, so V8's max-string-length is never hit at the split stage.
 */
class LedgerLineSplitter {
  private pending: Buffer[] = [];
  private pendingLength = 0;
  /** When true we are discarding the remainder of an oversized line. */
  private droppingOversized = false;
  /** Byte length of the oversized line accumulated so far (for offset math). */
  private droppedLength = 0;

  constructor(
    private readonly maxLineBytes: number = MAX_LEDGER_LINE_BYTES,
    private byteOffset: number = 0,
  ) {}

  push(chunk: Buffer): RawLedgerLine[] {
    const lines: RawLedgerLine[] = [];
    let cursor = 0;
    while (cursor < chunk.length) {
      const newlineIndex = chunk.indexOf(NEWLINE_BYTE, cursor);
      if (newlineIndex === -1) {
        this.appendTail(chunk.subarray(cursor));
        break;
      }
      const segment = chunk.subarray(cursor, newlineIndex + 1); // include '\n'
      const line = this.completeLine(segment);
      if (line) lines.push(line);
      cursor = newlineIndex + 1;
    }
    return lines;
  }

  /** Flush a trailing line with no terminating newline (EOF). */
  flush(): RawLedgerLine | undefined {
    if (this.droppingOversized) {
      // Oversized final line without a trailing newline: account its bytes and
      // report it as an oversized (skipped) line so callers can advance offset.
      const byteOffset = this.byteOffset + this.droppedLength;
      const line: RawLedgerLine = { byteOffset, oversized: true };
      this.reset();
      this.byteOffset = byteOffset;
      return line;
    }
    if (this.pendingLength === 0) return undefined;
    const byteOffset = this.byteOffset + this.pendingLength;
    const line: RawLedgerLine = {
      bytes: Buffer.concat(this.pending, this.pendingLength),
      byteOffset,
      oversized: false,
    };
    this.reset();
    this.byteOffset = byteOffset;
    return line;
  }

  private appendTail(segment: Buffer): void {
    if (this.droppingOversized) {
      this.droppedLength += segment.length;
      return;
    }
    if (this.pendingLength + segment.length > this.maxLineBytes) {
      // Transition into oversized-drop mode: discard what we buffered plus this
      // segment; only keep the running byte count so offsets stay correct.
      this.droppingOversized = true;
      this.droppedLength = this.pendingLength + segment.length;
      this.pending = [];
      this.pendingLength = 0;
      return;
    }
    this.pending.push(Buffer.from(segment));
    this.pendingLength += segment.length;
  }

  private completeLine(segment: Buffer): RawLedgerLine | undefined {
    if (this.droppingOversized) {
      // This segment closes an oversized line. Emit an oversized marker so the
      // offset advances, then reset to parse subsequent lines normally.
      const totalDropped = this.droppedLength + segment.length;
      const byteOffset = this.byteOffset + totalDropped;
      this.byteOffset = byteOffset;
      this.droppingOversized = false;
      this.droppedLength = 0;
      return { byteOffset, oversized: true };
    }
    if (this.pendingLength + segment.length > this.maxLineBytes) {
      // Oversized line terminated within this segment. Skip it entirely.
      const byteOffset = this.byteOffset + this.pendingLength + segment.length;
      this.byteOffset = byteOffset;
      this.pending = [];
      this.pendingLength = 0;
      return { byteOffset, oversized: true };
    }
    const bytes =
      this.pendingLength === 0
        ? Buffer.from(segment)
        : Buffer.concat([...this.pending, segment], this.pendingLength + segment.length);
    const byteOffset = this.byteOffset + bytes.length;
    this.byteOffset = byteOffset;
    this.pending = [];
    this.pendingLength = 0;
    return { bytes, byteOffset, oversized: false };
  }

  private reset(): void {
    this.pending = [];
    this.pendingLength = 0;
    this.droppingOversized = false;
    this.droppedLength = 0;
  }
}

function parseRawLedgerLine(
  line: RawLedgerLine,
  sessionId: string,
): ParsedLedgerEventWithOffset | undefined {
  if (line.oversized || !line.bytes) return undefined;
  let text: string;
  try {
    text = line.bytes.toString('utf-8');
  } catch (err) {
    // Defensive: a line under the byte cap should always decode, but never let
    // a decode overflow escape and abort the whole scan.
    if (isStringLengthOverflowError(err)) return undefined;
    throw err;
  }
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const event = parseLedgerLine(trimmed);
  if (event && event.sessionId === sessionId) return { event, byteOffset: line.byteOffset };
  return undefined;
}

/**
 * Stream a ledger file event-by-event for the target session, together with
 * the cumulative byte offset through the end of each line. Reads raw byte
 * chunks and splits on newline at the byte level, so peak memory is bounded and
 * a single pathological line larger than {@link MAX_LEDGER_LINE_BYTES} is
 * skipped WITHOUT truncating the events that follow it. Nothing here ever
 * materializes the whole file (or an oversized line) into a JS string, so V8's
 * max-string-length is never hit. `startByteOffset` must be a validated JSONL
 * boundary and keeps emitted offsets absolute to the file.
 */
export async function* streamLedgerEvents(
  ledgerPath: string,
  sessionId: string,
  maxLineBytes: number = MAX_LEDGER_LINE_BYTES,
  startByteOffset: number = 0,
): AsyncIterable<ParsedLedgerEventWithOffset> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(
      ledgerPath,
      startByteOffset > 0 ? { start: startByteOffset } : undefined,
    ); // no encoding → Buffer chunks
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const splitter = new LedgerLineSplitter(maxLineBytes, startByteOffset);
  try {
    for await (const chunk of stream) {
      for (const line of splitter.push(chunk as Buffer)) {
        const parsed = parseRawLedgerLine(line, sessionId);
        if (parsed) yield parsed;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const tail = splitter.flush();
  if (tail) {
    const parsed = parseRawLedgerLine(tail, sessionId);
    if (parsed) yield parsed;
  }
}

/**
 * Synchronous byte-level scan mirroring {@link streamLedgerEvents}. Used by the
 * append path (`readLedgerWatermarkSync`) and cursor validation
 * (`assertLedgerCursorOffsetSync`), both of which run under the synchronous
 * append/allocation lock. Reads the file in fixed-size chunks via `readSync`,
 * so it never materializes the whole file (or an oversized line) into a string.
 */
export function scanLedgerEventsSync(
  ledgerPath: string,
  sessionId: string,
  maxLineBytes: number = MAX_LEDGER_LINE_BYTES,
): ParsedLedgerEventWithOffset[] {
  const events: ParsedLedgerEventWithOffset[] = [];
  visitLedgerEventsSync(ledgerPath, sessionId, maxLineBytes, (parsed) => {
    events.push(parsed);
  });
  return events;
}

function visitLedgerEventsSync(
  ledgerPath: string,
  sessionId: string,
  maxLineBytes: number,
  visit: (parsed: ParsedLedgerEventWithOffset) => boolean | void,
): void {
  let fd: number;
  try {
    fd = openSync(ledgerPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const splitter = new LedgerLineSplitter(maxLineBytes);
  const CHUNK = 1024 * 1024;
  const buffer = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      for (const line of splitter.push(buffer.subarray(0, bytesRead))) {
        const parsed = parseRawLedgerLine(line, sessionId);
        if (parsed && visit(parsed) === false) return;
      }
    }
  } finally {
    closeSync(fd);
  }
  const tail = splitter.flush();
  if (tail) {
    const parsed = parseRawLedgerLine(tail, sessionId);
    if (parsed) visit(parsed);
  }
}

export function readLedgerWatermarkSync(
  ledgerPath: string,
  sessionId: string,
  maxLineBytes: number = MAX_LEDGER_LINE_BYTES,
): LocalSessionLedgerWatermark | undefined {
  // Byte-level streaming scan: recovers the true last event even when the
  // ledger exceeds V8's max string length, so the SQLite watermark can be
  // repaired from the file (e.g. after a crash between JSONL write and SQLite
  // commit). Never returns undefined merely because the file is huge — that
  // would drop the file watermark and risk reusing an already-allocated seq.
  let last: ParsedLedgerEventWithOffset | undefined;
  visitLedgerEventsSync(ledgerPath, sessionId, maxLineBytes, (next) => {
    if (!last || compareLedgerEvents(next.event, last.event) > 0) last = next;
  });
  if (!last) return undefined;
  return {
    sessionId,
    lastSeq: last.event.seq,
    lastEventId: last.event.eventId,
    updatedAtMs: last.event.createdAtMs,
    byteOffset: last.byteOffset,
  };
}

export function assertLedgerCursorOffsetSync(
  ledgerPath: string,
  sessionId: string,
  cursor: LocalSessionLedgerWatermark,
  maxLineBytes: number = MAX_LEDGER_LINE_BYTES,
): void {
  if (cursor.byteOffset === undefined) return;
  if (cursor.lastSeq === 0) {
    if (cursor.byteOffset === 0 && cursor.lastEventId === '') return;
    throw new Error(
      `Local session ledger cursor does not match ledger start: ${ledgerPath} session=${sessionId}`,
    );
  }
  // Byte-level streaming scan instead of a whole-file readFileSync, so cursor
  // validation on a huge ledger does not itself trip the string-length limit
  // and force readEventsAfter back into a full replay.
  let match = false;
  visitLedgerEventsSync(ledgerPath, sessionId, maxLineBytes, ({ event, byteOffset }) => {
    match =
      event.seq === cursor.lastSeq &&
      event.eventId === cursor.lastEventId &&
      byteOffset === cursor.byteOffset;
    return !match;
  });
  if (!match) {
    throw new Error(
      `Local session ledger cursor does not match ledger event: ${ledgerPath} session=${sessionId} seq=${cursor.lastSeq}`,
    );
  }
}

function parseLedgerLine(line: string): LocalSessionLedgerEvent | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isLocalSessionLedgerEvent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseLedgerContents(
  contents: string,
  sessionId: string,
): LocalSessionLedgerEvent[] {
  const events = parseLedgerContentsWithOffsets(contents, sessionId).map(({ event }) => event);
  return events.sort(compareLedgerEvents);
}

function parseLedgerContentsWithOffsets(
  contents: string,
  sessionId: string,
): ParsedLedgerEventWithOffset[] {
  const events: ParsedLedgerEventWithOffset[] = [];
  let lineStart = 0;
  let byteOffset = 0;
  while (lineStart < contents.length) {
    const newlineIndex = contents.indexOf('\n', lineStart);
    const lineEnd = newlineIndex >= 0 ? newlineIndex : contents.length;
    const rawLine = contents.slice(lineStart, lineEnd);
    const rawSegment = newlineIndex >= 0 ? contents.slice(lineStart, newlineIndex + 1) : rawLine;
    byteOffset += Buffer.byteLength(rawSegment, 'utf-8');
    const trimmed = rawLine.trim();
    if (trimmed) {
      const event = parseLedgerLine(trimmed);
      if (event && event.sessionId === sessionId) events.push({ event, byteOffset });
    }
    lineStart = newlineIndex >= 0 ? newlineIndex + 1 : contents.length;
  }
  return events.sort((left, right) => compareLedgerEvents(left.event, right.event));
}
