import { readFile, stat } from 'node:fs/promises';

export interface CliSunsetCandidateFile {
  path: string;
  content: string;
  mtimeMs: number;
}

export interface CliSunsetNoticeEvaluator {
  evaluate(
    nowMs: number,
    loadFiles: () => Promise<readonly CliSunsetCandidateFile[]>,
  ): Promise<{ paths: string[]; teamPaths: string[] } | undefined>;
}

/** Load memory files as sniff candidates; unreadable/missing entries are skipped. */
export async function loadCliSunsetCandidates(input: {
  mainPath: string | undefined;
  mainContent: string;
  userPath: string | undefined;
  userContent: string;
  topicPaths: string[];
}): Promise<CliSunsetCandidateFile[]> {
  const candidates = await Promise.all([
    withMtime(input.mainPath, async () => input.mainContent),
    withMtime(input.userPath, async () => input.userContent),
    ...input.topicPaths.map((path) => withMtime(path, () => readFile(path, 'utf8'))),
  ]);
  return candidates.filter((c): c is CliSunsetCandidateFile => c !== undefined);
}

async function withMtime(
  path: string | undefined,
  read: () => Promise<string>,
): Promise<CliSunsetCandidateFile | undefined> {
  if (!path) return undefined;
  try {
    const [content, stats] = await Promise.all([read(), stat(path)]);
    return { path, content, mtimeMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}
