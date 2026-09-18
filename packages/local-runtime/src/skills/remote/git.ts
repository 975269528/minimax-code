import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

import { LocalSkillHubInstallError } from '../hub-errors.js';
import type {
  LocalSkillPreviewRepoInfo,
  ScannedSkillCandidate,
  SkillArchiveFile,
} from './archive.js';
import type { RemoteSkillArchiveCandidate } from './github.js';

type SkillFileScanner = (
  files: SkillArchiveFile[],
  hintSubPath?: string,
  exactHintSubPath?: boolean,
) => Promise<ScannedSkillCandidate[]>;

const execFile = promisify(execFileCallback);
const REMOTE_SKILL_GIT_TIMEOUT_MS = 120_000;

export async function scanGithubSkillRepository(
  archive: RemoteSkillArchiveCandidate,
  scanSkillFiles: SkillFileScanner,
): Promise<{
  candidates: ScannedSkillCandidate[];
  repoInfo: LocalSkillPreviewRepoInfo;
}> {
  if (!archive.github) {
    throw new LocalSkillHubInstallError(
      'Remote skill preview requires a GitHub repository URL.',
      'LOCAL_SKILL_HUB_REMOTE_INVALID_URL',
      400,
    );
  }

  const checkoutDir = await mkdtemp(join(tmpdir(), 'mavis-skill-github-'));
  try {
    const repoUrl = `https://github.com/${archive.github.owner}/${archive.github.repo}.git`;
    await runGit(checkoutDir, ['init']);
    await runGit(checkoutDir, ['remote', 'add', 'origin', repoUrl]);
    await runGit(checkoutDir, [
      'fetch',
      '--depth',
      '1',
      '--filter=blob:none',
      '--no-tags',
      'origin',
      archive.github.ref,
    ]);
    await runGit(checkoutDir, ['checkout', '--force', 'FETCH_HEAD']);

    const sha = readFullGitSha((await runGit(checkoutDir, ['rev-parse', 'HEAD'])).trim());
    return {
      candidates: await scanSkillFiles(
        await normalizeDirectoryFiles(checkoutDir),
        archive.scanHintSubPath ?? archive.repoInfo.hint_sub_path,
        archive.exactHintSubPath,
      ),
      repoInfo: {
        ...archive.repoInfo,
        ...(sha ? { sha } : {}),
      },
    };
  } catch (err) {
    if (err instanceof LocalSkillHubInstallError) throw err;
    throw new LocalSkillHubInstallError(
      `Failed to download remote skill repository: ${formatError(err)}`,
      'LOCAL_SKILL_HUB_REMOTE_DOWNLOAD_FAILED',
      502,
    );
  } finally {
    await rm(checkoutDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return execFile('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: REMOTE_SKILL_GIT_TIMEOUT_MS,
    windowsHide: true,
  }).then((result) => result.stdout);
}

async function normalizeDirectoryFiles(root: string): Promise<SkillArchiveFile[]> {
  const absolutePaths = await readDirectoryFiles(root);
  const files = await Promise.all(
    absolutePaths.map(async (absolutePath): Promise<SkillArchiveFile | undefined> => {
      const path = normalizeRepoPath(relative(root, absolutePath));
      if (!path) return undefined;
      return {
        path,
        sizeBytes: (await stat(absolutePath)).size,
        readBuffer: () => readFile(absolutePath),
        readString: () => readFile(absolutePath, 'utf8'),
      };
    }),
  );
  return files.filter((file): file is SkillArchiveFile => file !== undefined);
}

async function readDirectoryFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      if (entry.name === '.git') return [];
      const path = join(root, entry.name);
      if (entry.isDirectory()) return readDirectoryFiles(path);
      if (entry.isFile()) return [path];
      return [];
    }),
  );
  return nested.flat();
}

function normalizeRepoPath(value: string | undefined): string | undefined {
  const normalized = value
    ?.split(/[\\/]+/u)
    .filter((part) => part.length > 0 && part !== '.')
    .join('/');
  return normalized || undefined;
}

function readFullGitSha(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-f0-9]{40}$/iu.test(value) ? value : undefined;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
