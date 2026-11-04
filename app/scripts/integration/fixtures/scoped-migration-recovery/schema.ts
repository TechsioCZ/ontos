import { integer, pgSchema } from 'drizzle-orm/pg-core';

const recovery = pgSchema('scoped_migration_recovery_fixture');
export const proof = recovery.table('proof', {
  effects: integer('effects').notNull(),
  id: integer('id').primaryKey(),
  nativeApplied: integer('native_applied').notNull().default(1),
});
