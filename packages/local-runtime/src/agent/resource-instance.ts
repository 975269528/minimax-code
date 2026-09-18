import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Read-only incarnation check: never materializes an Agent or reads its configuration. */
export async function matchesAgentResourceInstance(
  dataDir: string,
  agentName: string | undefined,
  expectedInstanceId: string,
): Promise<boolean> {
  if (
    !agentName ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      expectedInstanceId,
    )
  )
    return false;
  const agentsDir = resolve(dataDir, 'agents');
  const agentDir = resolve(agentsDir, agentName);
  if (dirname(agentDir) !== agentsDir) return false;
  const marker = join(agentDir, '.agent-instance-id');
  try {
    const directory = await lstat(agentDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) return false;
    const before = await lstat(marker);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 128) return false;
    const value = (await readFile(marker, 'utf8')).trim();
    const after = await lstat(marker);
    return (
      value === expectedInstanceId &&
      after.isFile() &&
      !after.isSymbolicLink() &&
      after.ino === before.ino &&
      after.dev === before.dev &&
      after.mtimeMs === before.mtimeMs
    );
  } catch {
    // Private resources are optional; a missing/unreadable marker cannot block a frozen Session.
    return false;
  }
}
