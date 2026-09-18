import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

export async function atomicWritePrivateFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);

  try {
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
