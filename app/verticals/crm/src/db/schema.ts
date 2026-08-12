/* eslint-disable sort-keys -- Columns follow the authoritative CRM storage order. */
import { enableGovernedRls, tenantRlsPolicies } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const CRM_SCHEMA_NAME = 'crm' as const;
export const CRM_TABLE_INVENTORY = ['contacts', 'customers'] as const;

export const crmSchema = pgSchema(CRM_SCHEMA_NAME);

export const customers = enableGovernedRls(
  crmSchema.table(
    'customers',
    {
      customerId: uuid('customer_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      name: text('name').notNull(),
      companyRegistrationNumber: text('company_registration_number'),
      taxIdentificationNumber: text('tax_identification_number'),
      email: text('email'),
      phone: text('phone'),
      website: text('website'),
      addressLine1: text('address_line_1'),
      addressLine2: text('address_line_2'),
      city: text('city'),
      region: text('region'),
      postalCode: text('postal_code'),
      countryCode: text('country_code'),
      version: integer('version').default(1).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
    },
    (table) => [
      uniqueIndex('crm_customers_tenant_customer_uk').on(table.tenantId, table.customerId),
      uniqueIndex('crm_customers_active_registration_uk')
        .on(table.tenantId, table.companyRegistrationNumber)
        .where(sql`${table.companyRegistrationNumber} is not null and ${table.deletedAt} is null`),
      index('crm_customers_tenant_name_id_idx').on(table.tenantId, table.name, table.customerId),
      check(
        'crm_customers_name_ck',
        sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 1 and 300`,
      ),
      check('crm_customers_version_ck', sql`${table.version} >= 1`),
      check(
        'crm_customers_country_code_ck',
        sql`${table.countryCode} is null or ${table.countryCode} ~ '^[A-Z]{2}$'`,
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
      firstName: text('first_name'),
      lastName: text('last_name'),
      email: text('email'),
      phone: text('phone'),
      jobTitle: text('job_title'),
      isPrimaryContact: boolean('is_primary_contact').default(false).notNull(),
      version: integer('version').default(1).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
    },
    (table) => [
      uniqueIndex('crm_contacts_tenant_contact_uk').on(table.tenantId, table.contactId),
      uniqueIndex('crm_contacts_tenant_customer_contact_uk').on(
        table.tenantId,
        table.customerId,
        table.contactId,
      ),
      foreignKey({
        columns: [table.tenantId, table.customerId],
        foreignColumns: [customers.tenantId, customers.customerId],
        name: 'crm_contacts_customer_fk',
      }).onDelete('restrict'),
      index('crm_contacts_active_customer_name_id_idx')
        .on(table.tenantId, table.customerId, table.lastName, table.firstName, table.contactId)
        .where(sql`${table.deletedAt} is null`),
      check(
        'crm_contacts_name_ck',
        sql`(${table.firstName} is null or (${table.firstName} = btrim(${table.firstName}) and not (${table.firstName} ~ '^[[:space:]]|[[:space:]]$') and char_length(${table.firstName}) between 1 and 200)) and (${table.lastName} is null or (${table.lastName} = btrim(${table.lastName}) and not (${table.lastName} ~ '^[[:space:]]|[[:space:]]$') and char_length(${table.lastName}) between 1 and 200)) and (${table.firstName} is not null or ${table.lastName} is not null)`,
      ),
      check('crm_contacts_version_ck', sql`${table.version} >= 1`),
      ...tenantRlsPolicies('crm_contacts_tenant', table.tenantId),
    ],
  ),
);

export const crmDatabaseSchema = { contacts, customers };
