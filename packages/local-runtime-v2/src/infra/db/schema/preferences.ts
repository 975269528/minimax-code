import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const preferences = sqliteTable('local_runtime_preferences', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});
