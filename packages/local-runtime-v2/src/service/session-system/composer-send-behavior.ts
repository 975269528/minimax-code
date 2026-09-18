import type { AppDb } from '../../infra/db/client.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';

const PREFERENCE_KEY = 'composer-send-behavior';
export type ComposerSendBehavior = 'queue' | 'steer';

export class ComposerSendBehaviorPreference {
  constructor(private readonly db: AppDb) {}

  async get(): Promise<ComposerSendBehavior> {
    return readPreferenceValue(this.db, PREFERENCE_KEY) === 'steer' ? 'steer' : 'queue';
  }

  async set(value: ComposerSendBehavior): Promise<void> {
    if (value !== 'queue' && value !== 'steer') throw new Error('Invalid composer send behavior');
    upsertPreferenceValue(this.db, PREFERENCE_KEY, value);
  }
}
