import path from 'node:path';

export function fallbackSkillName(relativeSkillFile: string): string {
  return path.posix.basename(path.posix.dirname(relativeSkillFile.replaceAll('\\', '/')));
}

export function readSkillStringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
