/** Compatibility owner contract; locking is implemented by the V2 session service. */
export interface LocalSessionLockOwner {
  ownerId: string;
  ownerKind: string;
}
