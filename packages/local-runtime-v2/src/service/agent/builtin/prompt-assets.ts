import { readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';

/** Eagerly captures the complete package before any template in the run is rendered. */
export async function captureLocalPromptAssets(root: string): Promise<ReadonlyMap<string, string>> {
  const contents = new Map<string, string>();
  async function visit(relativeDir: string): Promise<void> {
    for (const entry of await readdir(join(root, relativeDir), { withFileTypes: true })) {
      const relativePath = posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() && /(?:\.md(?:\.hbs)?|\.json)$/u.test(entry.name)) {
        contents.set(relativePath, await readFile(join(root, relativePath), 'utf8'));
      }
    }
  }
  await visit('');
  return contents;
}
