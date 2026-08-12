/* eslint-disable sort-keys -- Columns follow the authoritative CRM storage order. */
import {
  enableGovernedRls,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { DEAL_CURRENCY_CODES } from '../../shared/deal-currencies.ts';
import type { DealCurrencyCode } from '../../shared/deal-currencies.ts';

export const CRM_SCHEMA_NAME = 'crm' as const;
export const CRM_TABLE_INVENTORY = ['contacts', 'customers', 'deals'] as const;
export const DEAL_STATUSES = [
  'New',
  'Qualified',
  'Offer sent',
  'Negotiation',
  'Won',
  'Lost',
] as const;
export type DealStatus = (typeof DEAL_STATUSES)[number];

export const crmSchema = pgSchema(CRM_SCHEMA_NAME);
export const dealCurrencyCode = crmSchema.enum('deal_currency_code', DEAL_CURRENCY_CODES);

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

export const deals = enableGovernedRls(
  crmSchema.table(
    'deals',
    {
      dealId: uuid('deal_id').defaultRandom().primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      legalEntityId: uuid('legal_entity_id').notNull(),
      customerId: uuid('customer_id').notNull(),
      contactId: uuid('contact_id'),
      title: text('title').notNull(),
      description: text('description'),
      expectedValue: numeric('expected_value', {
        mode: 'number',
        precision: 14,
        scale: 2,
      }).notNull(),
      currency: dealCurrencyCode('currency').$type<DealCurrencyCode>().notNull(),
      expectedCloseDate: date('expected_close_date', { mode: 'string' }),
      status: text('status').$type<DealStatus>().default('New').notNull(),
      version: integer('version').default(1).notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
      deletedAt: timestamp('deleted_at', { withTimezone: true }),
    },
    (table) => [
      uniqueIndex('crm_deals_tenant_legal_entity_deal_uk').on(
        table.tenantId,
        table.legalEntityId,
        table.dealId,
      ),
      foreignKey({
        columns: [table.tenantId, table.customerId],
        foreignColumns: [customers.tenantId, customers.customerId],
        name: 'crm_deals_customer_fk',
      }).onDelete('restrict'),
      foreignKey({
        columns: [table.tenantId, table.customerId, table.contactId],
        foreignColumns: [contacts.tenantId, contacts.customerId, contacts.contactId],
        name: 'crm_deals_contact_fk',
      }).onDelete('restrict'),
      index('crm_deals_active_scope_updated_id_idx')
        .on(table.tenantId, table.legalEntityId, table.updatedAt.desc(), table.dealId.desc())
        .where(sql`${table.deletedAt} is null`),
      index('crm_deals_active_scope_customer_updated_id_idx')
        .on(
          table.tenantId,
          table.legalEntityId,
          table.customerId,
          table.updatedAt.desc(),
          table.dealId.desc(),
        )
        .where(sql`${table.deletedAt} is null`),
      check(
        'crm_deals_title_ck',
        sql`${table.title} = btrim(${table.title}) and char_length(${table.title}) between 1 and 300`,
      ),
      check(
        'crm_deals_description_ck',
        sql`${table.description} is null or (${table.description} = btrim(${table.description}) and char_length(${table.description}) between 1 and 5000)`,
      ),
      check(
        'crm_deals_expected_value_ck',
        sql`${table.expectedValue} >= 0 and ${table.expectedValue} <= 999999999999.99`,
      ),
      check(
        'crm_deals_expected_close_date_ck',
        sql`${table.expectedCloseDate} is null or extract(year from ${table.expectedCloseDate}) between 1 and 9999`,
      ),
      check(
        'crm_deals_status_ck',
        sql`${table.status} in ('New', 'Qualified', 'Offer sent', 'Negotiation', 'Won', 'Lost')`,
      ),
      check('crm_deals_version_ck', sql`${table.version} >= 1`),
      ...tenantLegalEntityRlsPolicies(
        'crm_deals_tenant_legal_entity',
        table.tenantId,
        table.legalEntityId,
      ),
    ],
  ),
);

export const crmDatabaseSchema = { contacts, customers, deals };
