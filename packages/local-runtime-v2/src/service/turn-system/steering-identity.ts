export function steeringReceiptId(input: {
  readonly producerId: string;
  readonly idempotencyKey: string;
}): string {
  return `steer:${input.producerId}\u0000${input.idempotencyKey}`;
}

export function steeringMessageKey(input: {
  readonly producerId: string;
  readonly idempotencyKey: string;
}): string {
  return `steer:${input.producerId}:${input.idempotencyKey}`;
}
