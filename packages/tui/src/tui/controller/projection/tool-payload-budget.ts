import type { TranscriptCellStatus } from '../../transcript/model.js';

const MAX_TOOL_TEXT_BYTES = 64 * 1_024;

interface BoundedToolText {
  readonly text: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
}

export function retainedToolText(text: string, originalBytes?: number): BoundedToolText {
  const visibleBytes = Buffer.byteLength(text);
  return {
    text,
    originalBytes: originalBytes ?? visibleBytes,
    truncated: originalBytes !== undefined && originalBytes > visibleBytes,
  };
}

export function mergeToolDetail(
  current: BoundedToolText,
  incoming: string,
  status: TranscriptCellStatus,
): BoundedToolText {
  if (!incoming) return current;
  if (status === 'succeeded' || status === 'failed') return boundToolText(incoming);
  if (!current.text) return boundToolText(incoming);
  const currentRetained = current.truncated ? retainedHeadAndTail(current.text) : current.text;
  const currentHead = current.truncated ? retainedHead(current.text) : current.text;
  if (incoming.startsWith(currentHead)) {
    return Buffer.byteLength(incoming) >= current.originalBytes ? boundToolText(incoming) : current;
  }
  if (currentHead.startsWith(incoming)) return current;
  const separator = currentRetained.endsWith('\n') || incoming.startsWith('\n') ? '' : '\n';
  return boundToolText(
    `${currentRetained}${separator}${incoming}`,
    current.originalBytes + Buffer.byteLength(separator) + Buffer.byteLength(incoming),
  );
}

export function boundToolText(
  value: string,
  originalBytes = Buffer.byteLength(value),
): BoundedToolText {
  if (originalBytes <= MAX_TOOL_TEXT_BYTES) {
    return { text: value, originalBytes, truncated: false };
  }
  const marker = `\n… [truncated: ${originalBytes} bytes total] …\n`;
  const retainedBytes = MAX_TOOL_TEXT_BYTES - Buffer.byteLength(marker);
  const headBytes = Math.ceil(retainedBytes / 2);
  const tailBytes = Math.floor(retainedBytes / 2);
  return {
    text: `${takeUtf8Start(value, headBytes)}${marker}${takeUtf8End(value, tailBytes)}`,
    originalBytes,
    truncated: true,
  };
}

function retainedHead(value: string): string {
  const markerStart = value.indexOf('\n… [truncated: ');
  return markerStart >= 0 ? value.slice(0, markerStart) : value;
}

function retainedHeadAndTail(value: string): string {
  const markerStart = value.indexOf('\n… [truncated: ');
  if (markerStart < 0) return value;
  const markerEnd = value.indexOf(' bytes total] …\n', markerStart);
  if (markerEnd < 0) return value;
  return `${value.slice(0, markerStart)}${value.slice(markerEnd + ' bytes total] …\n'.length)}`;
}

function takeUtf8Start(value: string, maxBytes: number): string {
  let usedBytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    end += char.length;
  }
  return copyUtf8(value.slice(0, end));
}

function takeUtf8End(value: string, maxBytes: number): string {
  let usedBytes = 0;
  let start = value.length;
  while (start > 0) {
    const lastUnit = value.charCodeAt(start - 1);
    const charStart = lastUnit >= 0xdc00 && lastUnit <= 0xdfff && start > 1 ? start - 2 : start - 1;
    const char = value.slice(charStart, start);
    const charBytes = Buffer.byteLength(char);
    if (usedBytes + charBytes > maxBytes) break;
    usedBytes += charBytes;
    start = charStart;
  }
  return copyUtf8(value.slice(start));
}

function copyUtf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}
