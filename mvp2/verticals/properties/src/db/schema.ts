import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const propertiesSchema = pgSchema('properties');

export const unit = propertiesSchema.table('unit', {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  name: text('name').notNull(),
  unitId: uuid('unit_id').defaultRandom().primaryKey(),
});
