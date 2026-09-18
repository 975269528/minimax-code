/** Diagnostics are summaries, never reversible copies of user content.
 * No arbitrary strings or object keys are emitted, including on malformed input.
 */
const ENUMS: Readonly<Record<string, readonly string[]>> = {
  role: ['user', 'assistant', 'system', 'tool'],
  level: ['trace', 'debug', 'info', 'warn', 'error', 'fatal'],
  status: ['pending', 'running', 'completed', 'failed', 'cancelled', 'error', 'success'],
  name: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError'],
  code: ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'],
};
const SOURCE_KINDS = new Set([
  'manifest.json',
  'messages.jsonl',
  'display.jsonl',
  'ledger.jsonl',
  'snapshot.json',
  'llm-call.json',
  'task-agent-definition.json',
  'session-report-collection.json',
]);

export function summarizeDiagnosticText(text: string, sourceName: string): string {
  const counts: Record<string, Record<string, number>> = {};
  let parsedRecords = 0;
  let omittedRecords = 0;
  let remaining = 100_000;
  let limited = false;
  function count(key: string, value: string): void {
    const bucket = counts[key] ?? (counts[key] = {});
    bucket[value] = (bucket[value] ?? 0) + 1;
  }
  function visit(value: unknown, depth: number): void {
    if (remaining-- <= 0 || depth > 32) {
      limited = true;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (remaining <= 0) {
          limited = true;
          break;
        }
        visit(child, depth + 1);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (remaining <= 0) {
        limited = true;
        break;
      }
      const allowed = Object.hasOwn(ENUMS, key) ? ENUMS[key] : undefined;
      if (typeof child === 'string' && allowed?.includes(child)) count(key, child);
      if (
        (key === 'status' || key === 'statusCode') &&
        typeof child === 'number' &&
        Number.isInteger(child) &&
        child >= 100 &&
        child <= 599
      ) {
        count('httpStatus', String(child));
      }
      // Values are inspected only for bounded enum counts. No source keys are copied.
      visit(child, depth + 1);
    }
  }
  function parse(record: string): void {
    if (!record.trim()) return;
    if (remaining <= 0) {
      limited = true;
      return;
    }
    try {
      visit(JSON.parse(record), 0);
      parsedRecords += 1;
    } catch {
      omittedRecords += 1;
    }
  }
  if (sourceName.endsWith('.json')) parse(text);
  else for (const line of text.split('\n')) parse(line);
  const baseName = sourceName.split('/').at(-1) ?? '';
  return JSON.stringify({
    schemaVersion: 1,
    redactionPolicy: 'diagnostic-counts-v1',
    sourceKind: SOURCE_KINDS.has(baseName) ? baseName : 'other',
    contentOmitted: true,
    parsedRecords,
    omittedRecords,
    limited,
    counts,
  });
}
