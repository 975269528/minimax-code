interface AssetCursorRow {
  readonly id: number;
  readonly sessionId: string;
  readonly messageCreatedAtMs: number;
}

export function encodeAssetCursor(row: AssetCursorRow): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'asset',
      s: row.sessionId,
      c: row.messageCreatedAtMs,
      i: row.id,
    }),
  ).toString('base64url');
}

export function decodeAssetCursor(
  value: string | undefined,
  sessionId: string,
): { readonly messageCreatedAtMs: number; readonly id: number } | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString());
    return isAssetCursor(parsed, sessionId)
      ? { messageCreatedAtMs: parsed.c, id: parsed.i }
      : undefined;
  } catch {
    return undefined;
  }
}

function isAssetCursor(
  value: unknown,
  sessionId: string,
): value is { readonly c: number; readonly i: number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.k === 'asset' &&
    record.s === sessionId &&
    Number.isSafeInteger(record.c) &&
    Number.isSafeInteger(record.i) &&
    (record.i as number) > 0
  );
}
