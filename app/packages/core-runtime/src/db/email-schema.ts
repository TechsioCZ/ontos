import { sql } from 'drizzle-orm';
import { check, index, integer, pgPolicy, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Platform-owned after-commit mail ledger; only migrations create or alter it. Rows carry recipient and subject, so
 * the runtime role sees only the rows of the tenant + legal entity installed in its transaction (FORCE RLS, migration).
 * The dispatcher learns which scopes have work from demo_email.pending_deliveries(), which returns ids only.
 */
export const emailSchema = pgSchema('demo_email');
const scoped = sql`tenant_id = nullif(current_setting('ontos.tenant_id', true), '')::uuid and legal_entity_id = nullif(current_setting('ontos.legal_entity_id', true), '')::uuid`;
export const emailDeliveries = emailSchema.table.withRLS(
  'deliveries',
  {
    attempts: integer('attempts').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    dedupeKey: text('dedupe_key').primaryKey(),
    emailSubject: text('email_subject').notNull(),
    errorTag: text('error_tag'),
    event: text('event').notNull(),
    eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
    eventLabel: text('event_label'),
    legalEntityId: uuid('legal_entity_id').notNull(),
    messageId: text('message_id'),
    recipient: text('recipient').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    source: text('source').notNull(),
    status: text('status').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectNumber: text('subject_number').default('').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'deliveries_source_check',
      sql`${table.source} in ('akros-order', 'facility-agenda', 'rent-reminder', 'storefront-inquiry', 'person-invitation')`,
    ),
    check(
      'deliveries_status_check',
      sql`${table.status} in ('SENDING', 'SENT', 'RETRY', 'FAILED', 'UNKNOWN', 'SKIPPED')`,
    ),
    index('deliveries_subject_idx').on(table.source, table.subjectId),
    index('deliveries_number_idx').on(table.source, table.subjectNumber),
    pgPolicy('demo_email_deliveries_scope_select', { for: 'select', to: 'ontos_runtime', using: scoped }),
    pgPolicy('demo_email_deliveries_scope_insert', { for: 'insert', to: 'ontos_runtime', withCheck: scoped }),
    pgPolicy('demo_email_deliveries_scope_update', {
      for: 'update',
      to: 'ontos_runtime',
      using: scoped,
      withCheck: scoped,
    }),
  ],
);
export const emailSettings = emailSchema.table('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
