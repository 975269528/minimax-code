import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import yaml from 'js-yaml';

const mutationLane = new KeyedOperationLane<string>();

export interface DurableYamlFaultHooks {
  afterTempSync?(): void | Promise<void>;
  beforeRename?(): void | Promise<void>;
  afterRename?(): void | Promise<void>;
}

export interface DurableYamlMutationResult<T> {
  readonly changed: boolean;
  readonly value: T;
}

/**
 * Serialize one complete YAML-file read/modify/write cycle.  Callers mutate
 * the raw document so fields written by a newer release remain untouched.
 */
export function mutateDurableYaml<T>(
  filePath: string,
  mutate: (
    document: Record<string, unknown>,
  ) => DurableYamlMutationResult<T> | Promise<DurableYamlMutationResult<T>>,
  hooks: DurableYamlFaultHooks = {},
): Promise<T> {
  return mutationLane.run(filePath, async () => {
    const document = await readYamlDocument(filePath);
    const result = await mutate(document);
    if (result.changed) {
      await writeFileDurably(
        filePath,
        yaml.dump(document, { lineWidth: 120, noRefs: true }),
        hooks,
      );
    }
    return result.value;
  });
}

export async function readYamlDocument(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!raw) return {};
  const parsed = yaml.load(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
}

/** Same-directory temp + file fsync + atomic replace + best-effort dir fsync. */
export async function writeFileDurably(
  filePath: string,
  content: string,
  hooks: DurableYamlFaultHooks = {},
): Promise<void> {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  const tempPath = join(
    parent,
    `.${basename(filePath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  let published = false;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await hooks.afterTempSync?.();
    await hooks.beforeRename?.();
    await rename(tempPath, filePath);
    published = true;
    await hooks.afterRename?.();
    await syncDirectoryBestEffort(parent);
  } finally {
    if (!published) {
      await unlink(tempPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  const handle = await open(directory, 'r').catch((error: NodeJS.ErrnoException) => {
    if (isUnsupportedDirectorySync(error)) return undefined;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (!isUnsupportedDirectorySync(error)) throw error;
    });
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: NodeJS.ErrnoException): boolean {
  return error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'EPERM';
}
