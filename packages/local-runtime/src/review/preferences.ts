import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ReviewPreferencesService {
  readonly rulesPath: string;

  constructor(dataDir: string) {
    this.rulesPath = join(dataDir, 'review-rules', 'global.md');
  }

  async get(): Promise<string> {
    try {
      return await readFile(this.rulesPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async update(rules: string): Promise<string> {
    if (!rules.trim()) {
      await rm(this.rulesPath, { force: true });
      return '';
    }
    const parent = dirname(this.rulesPath);
    await mkdir(parent, { recursive: true });
    const temporaryPath = join(parent, `.global.md.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, rules, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.rulesPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return rules;
  }
}
