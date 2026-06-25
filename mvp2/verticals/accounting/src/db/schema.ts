import { date, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const accountingSchema = pgSchema('accounting');

export const invoice = accountingSchema.table('invoice', {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  customerName: text('customer_name').notNull(),
  dueDate: date('due_date').notNull(),
  invoiceId: uuid('invoice_id').defaultRandom().primaryKey(),
  invoiceNumber: text('invoice_number').notNull(),
  status: text('status').default('draft').notNull(),
});
