import { randomBytes } from 'node:crypto';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatLocalDateStamp(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
}

export function generateDefaultWorktreeBranch(nowMs: number = Date.now()): string {
  return `feat/auto-${formatLocalDateStamp(new Date(nowMs))}-${randomBytes(4).toString('hex')}`;
}
