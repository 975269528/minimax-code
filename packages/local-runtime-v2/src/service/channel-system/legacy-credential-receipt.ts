import type { AppDb } from '../../infra/db/client.js';
import { readPreferenceValue, upsertPreferenceValue } from '../../infra/db/preference-values.js';

const LEGACY_CREDENTIAL_MIGRATION_KEY = 'legacy-im-credentials-migrated';

/** Owns only the retry receipt; V1 remains the narrow legacy-state migration executor. */
export class LegacyCredentialMigrationReceipt {
  constructor(private readonly db: AppDb) {}

  async run(action: () => Promise<void>): Promise<void> {
    if (readPreferenceValue(this.db, LEGACY_CREDENTIAL_MIGRATION_KEY) === true) return;
    await action();
    upsertPreferenceValue(this.db, LEGACY_CREDENTIAL_MIGRATION_KEY, true);
  }
}
