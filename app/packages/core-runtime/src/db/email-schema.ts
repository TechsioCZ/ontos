import { sql } from 'drizzle-orm';
import { check, index, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Platform-owned after-commit mail ledger; only migrations create or alter it. */
export const emailSchema = pgSchema('demo_email');
export const emailDeliveries = emailSchema.table(
  'deliveries',
  {
    dedupeKey: text('dedupe_key').primaryKey(),
    source: text('source').notNull(),
    event: text('event').notNull(),
    eventLabel: text('event_label'),
    tenantId: uuid('tenant_id').notNull(),
    legalEntityId: uuid('legal_entity_id').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectNumber: text('subject_number').default('').notNull(),
    recipient: text('recipient').notNull(),
    emailSubject: text('email_subject').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').default(1).notNull(),
    messageId: text('message_id'),
    errorTag: text('error_tag'),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    check('deliveries_source_check', sql`${table.source} in ('akros-order', 'facility-agenda', 'rent-reminder')`),
    check(
      'deliveries_status_check',
      sql`${table.status} in ('SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN', 'SKIPPED')`,
    ),
    index('deliveries_subject_idx').on(table.source, table.subjectId),
    index('deliveries_number_idx').on(table.source, table.subjectNumber),
  ],
);
export const emailSettings = emailSchema.table('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
