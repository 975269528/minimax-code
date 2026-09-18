export function maskSecret(value: string): string {
  return value.length > 8 ? `${value.slice(0, 4)}****${value.slice(-4)}` : '****';
}
