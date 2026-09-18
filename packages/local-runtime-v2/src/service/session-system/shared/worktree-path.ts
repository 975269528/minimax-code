import { pathFlavor, trimTrailingSeparators } from './path-normalization.js';

const NESTED_AGENT_WORKTREE_PARENT = '.\x63\x6c\x61\x75\x64\x65';

export function collapseWorktreePath(value: string): string {
  const flavor = pathFlavor(value);
  const parsed = flavor.parse(value);
  const parts = value
    .slice(parsed.root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  const markerIndex = findWorktreeMarker(parts);
  if (markerIndex === undefined) return value;
  return trimTrailingSeparators(`${parsed.root}${parts.slice(0, markerIndex).join(flavor.sep)}`);
}

function findWorktreeMarker(parts: readonly string[]): number | undefined {
  const simple = parts.findIndex((part) => part === '.worktrees' || part === '.worktree');
  if (simple >= 0 && simple < parts.length - 1) return simple;
  const nested = parts.findIndex(
    (part, index) => part === NESTED_AGENT_WORKTREE_PARENT && parts[index + 1] === 'worktrees',
  );
  return nested >= 0 && nested < parts.length - 2 ? nested : undefined;
}
