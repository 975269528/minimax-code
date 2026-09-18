import type {
  CDPConsoleDiagnosticEntry,
  CDPNetworkDiagnosticEntry,
  CDPNetworkDiagnosticResourceType,
  CDPNetworkDiagnosticStatusFilter,
} from './cdp-helper-contracts.js';
import {
  sanitizeConsoleDiagnosticUrl,
  sanitizeConsoleMessage,
  truncateConsoleValue,
} from './console-diagnostic-sanitizer.js';

export const MAX_CONSOLE_DIAGNOSTIC_ENTRIES = 200;
export const MAX_CONSOLE_DIAGNOSTIC_PAGE_BYTES = 48 * 1024;
export const MAX_NETWORK_DIAGNOSTIC_ENTRIES = 200;
export const MAX_NETWORK_DIAGNOSTIC_PAGE_BYTES = 48 * 1024;

const MAX_CONSOLE_STACK_FRAMES = 8;
const MAX_NETWORK_TEXT_CHARS = 1_024;

export const browserInputDiagnosticLogger = {
  info(fields: Record<string, unknown>): void {
    // eslint-disable-next-line no-console -- opt-in local browser diagnostics
    if (process.env.MAVIS_BROWSER_DEBUG === '1') console.info(fields);
  },
  warn(fields: Record<string, unknown>): void {
    // eslint-disable-next-line no-console -- opt-in local browser diagnostics
    if (process.env.MAVIS_BROWSER_DEBUG === '1') console.warn(fields);
  },
};

export interface CDPRemoteObjectSummary {
  type?: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
}

export interface CDPConsoleCallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}

export interface CDPConsoleStackTrace {
  callFrames?: CDPConsoleCallFrame[];
}

export interface BufferedConsoleDiagnosticEntry extends CDPConsoleDiagnosticEntry {
  exceptionId?: number;
}

export interface BufferedNetworkDiagnosticEntry extends CDPNetworkDiagnosticEntry {
  requestId: string;
  startedAtMonotonic: number;
  loaderId?: string;
}

export function sanitizeNetworkDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:') return 'data:[REDACTED]';
    if (url.protocol === 'blob:') {
      return `blob:${sanitizeConsoleDiagnosticUrl(value.slice('blob:'.length))}`;
    }
  } catch {
    // The common sanitizer still applies bounded best-effort credential/query removal.
  }
  return sanitizeConsoleDiagnosticUrl(value);
}

export function sanitizeNetworkText(value: string): string {
  return truncateConsoleValue(
    sanitizeConsoleMessage(value).replace(/\bdata:[^\s<>"']+/giu, 'data:[REDACTED]'),
    MAX_NETWORK_TEXT_CHARS,
  );
}

const NETWORK_RESOURCE_TYPES = new Set<CDPNetworkDiagnosticResourceType>([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'xhr',
  'fetch',
  'eventsource',
  'manifest',
  'preflight',
  'other',
]);

export function normalizeNetworkResourceType(value: unknown): CDPNetworkDiagnosticResourceType {
  const normalized = typeof value === 'string' ? value.toLowerCase() : 'other';
  return NETWORK_RESOURCE_TYPES.has(normalized as CDPNetworkDiagnosticResourceType)
    ? (normalized as CDPNetworkDiagnosticResourceType)
    : 'other';
}

export function networkStatusMatches(
  entry: CDPNetworkDiagnosticEntry,
  filters: ReadonlySet<CDPNetworkDiagnosticStatusFilter>,
): boolean {
  if (filters.size === 0) return true;
  if (filters.has('pending') && entry.outcome === 'pending') return true;
  if (filters.has('failed') && entry.outcome === 'failed') return true;
  if (filters.has('success') && entry.outcome === 'success') return true;
  if (typeof entry.status !== 'number') return false;
  const statusClass = `${Math.floor(entry.status / 100)}xx` as CDPNetworkDiagnosticStatusFilter;
  return filters.has(statusClass);
}

export function summarizeRemoteObject(remote: CDPRemoteObjectSummary): string {
  if (remote.value !== undefined) {
    if (typeof remote.value === 'string') return remote.value;
    if (remote.value === null) return 'null';
    return String(remote.value);
  }
  if (remote.unserializableValue) return remote.unserializableValue;
  if (remote.description) return remote.description;
  if (remote.subtype === 'null') return 'null';
  return remote.className || remote.subtype || remote.type || '';
}

export function formatConsoleStack(stackTrace?: CDPConsoleStackTrace): string[] | undefined {
  const frames = stackTrace?.callFrames?.slice(0, MAX_CONSOLE_STACK_FRAMES) ?? [];
  if (frames.length === 0) return undefined;
  return frames.map((frame) => {
    const fn = truncateConsoleValue(
      sanitizeConsoleMessage(frame.functionName || '<anonymous>'),
      256,
    );
    const url = sanitizeConsoleDiagnosticUrl(frame.url || '<unknown>');
    const line = Math.max(0, Number(frame.lineNumber ?? 0)) + 1;
    const column = Math.max(0, Number(frame.columnNumber ?? 0)) + 1;
    return `${fn} (${url}:${line}:${column})`;
  });
}
