export function isFutureQueueExpiry(expiresAt: number | undefined, nowMs: number): boolean {
  return expiresAt === undefined || (Number.isFinite(expiresAt) && expiresAt > nowMs);
}
