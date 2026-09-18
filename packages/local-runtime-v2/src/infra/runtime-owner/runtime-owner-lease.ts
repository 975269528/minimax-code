const LEASE_SCHEMA_VERSION = 1;

/**
 * What a `<instance>.owner` file claims about the Runtime that wrote it.
 *
 * `legacy` is the shape written before start-time recording existed (a bare PID) and is
 * also the shape a new writer degrades to when its platform cannot probe start times, or
 * a reader degrades to when the JSON record is unusable — `recordIssue` then carries why,
 * so a corrupt lease is still diagnosable from the fence logs.
 * `unreadable` means the file carries no usable PID at all: the fence must neither treat
 * it as a live owner nor reclaim it, exactly as an unparsable lease behaved before.
 */
export type RuntimeOwnerLease =
  | { readonly format: 'structured'; readonly pid: number; readonly startToken: string }
  | { readonly format: 'legacy'; readonly pid: number; readonly recordIssue?: string }
  | { readonly format: 'absent' }
  | { readonly format: 'unreadable' };

/**
 * Writes the lease as a bare PID line followed by a JSON record.
 *
 * The duplicated PID line is deliberate: ADR-005 requires the previous release to stay
 * launchable, and that binary reads the lease with `parseInt`. Keeping the PID on the
 * first line means a rolled-back Runtime still sees the exact owner PID instead of
 * falling back to the lock heartbeat alone, while a current Runtime additionally gets the
 * start token it needs to reject a reused PID.
 */
export function serializeRuntimeOwnerLease(input: {
  readonly pid: number;
  readonly startToken?: string;
}): string {
  const record = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    pid: input.pid,
    ...(input.startToken === undefined ? {} : { startToken: input.startToken }),
  };
  return `${String(input.pid)}\n${JSON.stringify(record)}\n`;
}

/**
 * Decodes lease text without ever making a parse failure fatal.
 *
 * The first line is authoritative for identity, so any missing, malformed or
 * disagreeing JSON record degrades to `legacy` — the fence then behaves exactly as it did
 * before start tokens existed instead of turning a corrupt file into a permanent refusal
 * to start.
 */
export function parseRuntimeOwnerLease(text: string | undefined): RuntimeOwnerLease {
  if (text === undefined) return { format: 'absent' };
  const [head = '', ...rest] = text.split('\n');
  const pid = Number.parseInt(head.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { format: 'unreadable' };
  const record = decodeLeaseRecord(rest.join('\n').trim(), pid);
  if (record.startToken !== undefined) {
    return { format: 'structured', pid, startToken: record.startToken };
  }
  return {
    format: 'legacy',
    pid,
    ...(record.issue === undefined ? {} : { recordIssue: record.issue }),
  };
}

function decodeLeaseRecord(
  payload: string,
  pid: number,
): { readonly startToken?: string; readonly issue?: string } {
  // A lease written before start tokens existed has no record line at all; that is the
  // supported legacy shape rather than a problem worth reporting.
  if (payload.length === 0) return {};
  const fields = parseLeaseRecordFields(payload);
  if (typeof fields === 'string') return { issue: fields };
  if (fields.schemaVersion !== LEASE_SCHEMA_VERSION) return { issue: 'unsupported-schema-version' };
  if (fields.pid !== pid) return { issue: 'pid-mismatch' };
  return decodeStartToken(fields.startToken);
}

/** Returns the record fields, or the issue code explaining why there are none. */
function parseLeaseRecordFields(payload: string): Record<string, unknown> | string {
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch {
    return 'invalid-json';
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'invalid-record';
  return record as Record<string, unknown>;
}

function decodeStartToken(startToken: unknown): {
  readonly startToken?: string;
  readonly issue?: string;
} {
  // A record without a token means the writer's platform had no probe: a normal degrade.
  if (startToken === undefined) return {};
  if (typeof startToken !== 'string' || startToken.length === 0) {
    return { issue: 'invalid-start-token' };
  }
  return { startToken };
}
