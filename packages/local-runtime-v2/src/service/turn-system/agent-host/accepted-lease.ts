export interface AcceptedLeaseIdentity {
  readonly sessionId: unknown;
  readonly turnId: unknown;
  readonly leaseId: unknown;
}

const trustedAbortSignalBrand = captureAbortSignalBrand();

export function hasAcceptedLeaseIdentity(
  turn: AcceptedLeaseIdentity,
): turn is AcceptedLeaseIdentity & {
  readonly sessionId: string;
  readonly turnId: string;
  readonly leaseId: string;
} {
  return [turn.sessionId, turn.turnId, turn.leaseId].every(isNonEmptyString);
}

export function isAbortSignalLike(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null || !trustedAbortSignalBrand) {
    return false;
  }
  try {
    const aborted = Reflect.apply(trustedAbortSignalBrand.abortedGetter, value, []);
    if (typeof aborted !== 'boolean') return false;
    return (
      typeof Reflect.get(value, 'addEventListener') === 'function' &&
      typeof Reflect.get(value, 'removeEventListener') === 'function'
    );
  } catch {
    return false;
  }
}

function captureAbortSignalBrand(): { readonly abortedGetter: () => boolean } | undefined {
  if (typeof AbortSignal === 'undefined') return undefined;
  const abortedGetter = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  return abortedGetter ? { abortedGetter } : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}
