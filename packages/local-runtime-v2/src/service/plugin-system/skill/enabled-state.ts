import type { AppDb } from '../../../infra/db/client.js';
import {
  deletePreferenceValue,
  readPreferenceValue,
  upsertPreferenceValue,
} from '../../../infra/db/preference-values.js';

const STANDALONE_SKILL_STATE_KEY = 'standalone-skill-disabled-state';

interface PersistedSkillState {
  readonly version: 1;
  readonly disabledLocationUris: readonly string[];
}

/** V2-owned enabled-state capability injected into the V1 discovery engine. */
export class SkillEnabledState {
  private loaded: Set<string> | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: AppDb) {}

  async getDisabledLocationUris(): Promise<ReadonlySet<string>> {
    return new Set(this.read());
  }

  async setEnabled(locationUri: string, enabled: boolean): Promise<void> {
    await this.mutate((disabled) => {
      if (enabled) disabled.delete(locationUri);
      else disabled.add(locationUri);
    });
  }

  async forget(locationUri: string): Promise<void> {
    await this.mutate((disabled) => disabled.delete(locationUri));
  }

  private async mutate(update: (disabled: Set<string>) => void): Promise<void> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const next = new Set(this.read());
      update(next);
      this.write(next);
      this.loaded = next;
    } finally {
      release();
    }
  }

  private read(): Set<string> {
    if (this.loaded) return this.loaded;
    const parsed = readPreferenceValue<Partial<PersistedSkillState>>(
      this.db,
      STANDALONE_SKILL_STATE_KEY,
    );
    const values =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed.disabledLocationUris
        : undefined;
    this.loaded = new Set(
      Array.isArray(values)
        ? values.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [],
    );
    return this.loaded;
  }

  private write(disabled: ReadonlySet<string>): void {
    if (disabled.size === 0) {
      deletePreferenceValue(this.db, STANDALONE_SKILL_STATE_KEY);
      return;
    }
    upsertPreferenceValue(this.db, STANDALONE_SKILL_STATE_KEY, {
      version: 1,
      disabledLocationUris: [...disabled].sort(),
    } satisfies PersistedSkillState);
  }
}
