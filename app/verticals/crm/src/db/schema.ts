/* eslint-disable sort-keys -- Typed columns follow the authoritative physical schema order. */
import { enableGovernedRls, tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const CRM_SCHEMA_NAME = 'crm';

export const CRM_TABLE_INVENTORY = ['contacts', 'customers'] as const;

export const crmSchema = pgSchema(CRM_SCHEMA_NAME);

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const customers = enableGovernedRls(
  crmSchema.table(
    'customers',
    {
      customerId: uuid('customer_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      name: text('name').notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      archivedAt: archivedAt(),
    },
    (table) => [
      unique('crm_customers_tenant_id_uk').on(table.tenantId, table.customerId),
      index('crm_customers_tenant_active_idx')
        .on(table.tenantId, table.name)
        .where(sql`${table.archivedAt} is null`),
      check(
        'crm_customers_name_ck',
        sql`${table.name} = btrim(${table.name}) and length(${table.name}) > 0`,
      ),
      ...tenantRlsPolicies('crm_customers_tenant', table.tenantId),
    ],
  ),
);

export const contacts = enableGovernedRls(
  crmSchema.table(
    'contacts',
    {
      contactId: uuid('contact_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      customerId: uuid('customer_id').notNull(),
      name: text('name').notNull(),
      email: text('email').notNull(),
      phone: text('phone').notNull(),
      createdAt: createdAt(),
      updatedAt: updatedAt(),
      archivedAt: archivedAt(),
    },
    (table) => [
      uniqueIndex('crm_contacts_tenant_id_uk').on(table.tenantId, table.contactId),
      index('crm_contacts_tenant_customer_active_idx')
        .on(table.tenantId, table.customerId, table.name)
        .where(sql`${table.archivedAt} is null`),
      foreignKey({
        columns: [table.tenantId, table.customerId],
        foreignColumns: [customers.tenantId, customers.customerId],
        name: 'crm_contacts_tenant_customer_fk',
      }).onDelete('restrict'),
      check(
        'crm_contacts_name_ck',
        sql`${table.name} = btrim(${table.name}) and length(${table.name}) > 0`,
      ),
      check('crm_contacts_email_ck', sql`length(btrim(${table.email})) > 0`),
      check('crm_contacts_phone_ck', sql`length(btrim(${table.phone})) > 0`),
      ...tenantRlsPolicies('crm_contacts_tenant', table.tenantId),
    ],
  ),
);

export const crmDatabaseSchema = {
  contacts,
  customers,
} as const;

export const CRM_TABLES = [contacts, customers] as const;

export type CustomerRecord = typeof customers.$inferSelect;
export type NewCustomerRecord = typeof customers.$inferInsert;
export type ContactRecord = typeof contacts.$inferSelect;
export type NewContactRecord = typeof contacts.$inferInsert;
