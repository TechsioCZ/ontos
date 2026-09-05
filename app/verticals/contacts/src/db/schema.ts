import { tenantRlsPolicies } from '@app/core-runtime';
import { defineRelations, sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const CONTACTS_SCHEMA_NAME = 'contacts';

export const CONTACTS_TABLE_INVENTORY = [
  'contacts',
  'customers',
  'gateway_assertion_redemptions',
] as const;

export const contactsSchema = pgSchema(CONTACTS_SCHEMA_NAME);

const createdAt = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
const archivedAt = () => timestamp('archived_at', { withTimezone: true });

export const customers = contactsSchema.table.withRLS(
  'customers',
  {
    customerId: uuid('customer_id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    name: text('name').notNull(),
    ico: text('ico'),
    dic: text('dic'),
    legalFormCode: text('legal_form_code'),
    establishedOn: date('established_on'),
    dissolvedOn: date('dissolved_on'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: archivedAt(),
  },
  (table) => [
    unique('contacts_customers_tenant_id_uk').on(table.tenantId, table.customerId),
    index('contacts_customers_tenant_active_idx')
      .on(table.tenantId, table.name)
      .where(sql`${table.archivedAt} is null`),
    uniqueIndex('contacts_customers_tenant_ico_uk').on(table.tenantId, table.ico),
    check(
      'contacts_customers_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) > 0`,
    ),
    check('contacts_customers_ico_ck', sql`${table.ico} is null or ${table.ico} ~ '^[0-9]{8}$'`),
    check(
      'contacts_customers_dic_ck',
      sql`${table.dic} is null or (${table.dic} = btrim(${table.dic}) and length(${table.dic}) between 1 and 20)`,
    ),
    check(
      'contacts_customers_legal_form_code_ck',
      sql`${table.legalFormCode} is null or ${table.legalFormCode} ~ '^[0-9]{3}$'`,
    ),
    check(
      'contacts_customers_lifecycle_dates_ck',
      sql`${table.dissolvedOn} is null or ${table.establishedOn} is null or ${table.dissolvedOn} >= ${table.establishedOn}`,
    ),
    ...tenantRlsPolicies('contacts_customers_tenant', table.tenantId),
  ],
);

export const contacts = contactsSchema.table.withRLS(
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
    uniqueIndex('contacts_contacts_tenant_id_uk').on(table.tenantId, table.contactId),
    index('contacts_contacts_tenant_customer_active_idx')
      .on(table.tenantId, table.customerId, table.name)
      .where(sql`${table.archivedAt} is null`),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.customerId],
      name: 'contacts_contacts_tenant_customer_fk',
    }).onDelete('restrict'),
    check(
      'contacts_contacts_name_ck',
      sql`${table.name} = btrim(${table.name}) and length(${table.name}) > 0`,
    ),
    check('contacts_contacts_email_ck', sql`length(btrim(${table.email})) > 0`),
    check('contacts_contacts_phone_ck', sql`length(btrim(${table.phone})) > 0`),
    ...tenantRlsPolicies('contacts_contacts_tenant', table.tenantId),
  ],
);

export const gatewayAssertionRedemptions = contactsSchema.table(
  'gateway_assertion_redemptions',
  {
    audience: text('audience').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    issuer: text('issuer').notNull(),
    jti: uuid('jti').notNull(),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('contacts_gateway_assertion_redemptions_identity_uk').on(
      table.issuer,
      table.audience,
      table.jti,
    ),
    index('contacts_gateway_assertion_redemptions_expiry_idx').on(table.expiresAt),
  ],
);

export const contactsDatabaseSchema = {
  contacts,
  customers,
  gatewayAssertionRedemptions,
} as const;

export const CONTACTS_TABLES = [contacts, customers, gatewayAssertionRedemptions] as const;

export type CustomerRecord = typeof customers.$inferSelect;
export type NewCustomerRecord = typeof customers.$inferInsert;
export type ContactRecord = typeof contacts.$inferSelect;
export type NewContactRecord = typeof contacts.$inferInsert;

/** Relational Queries v2 entry point for the Contacts owner (no navigational relations yet). */
export const contactsRelations = defineRelations(contactsDatabaseSchema);
