import assert from 'node:assert/strict';
import test from 'node:test';
import { isTable } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schemaExports from '../../src/db/schema.ts';
import {
  CRM_SCHEMA_NAME,
  CRM_TABLE_INVENTORY,
  contacts,
  crmSchema,
  customers,
  deals,
} from '../../src/db/schema.ts';

test('owns the exact typed CRM Customer, Contact, and Deal table inventory', () => {
  assert.equal(crmSchema.schemaName, CRM_SCHEMA_NAME);
  assert.deepEqual(CRM_TABLE_INVENTORY, ['contacts', 'customers', 'deals']);
  assert.deepEqual(Object.values(schemaExports).filter(isTable), [contacts, customers, deals]);
  const config = getTableConfig(customers);
  assert.equal(config.enableRLS, true);
  assert.deepEqual(config.policies.map(({ name }) => name).toSorted(), [
    'crm_customers_tenant_delete',
    'crm_customers_tenant_insert',
    'crm_customers_tenant_select',
    'crm_customers_tenant_update',
  ]);
  assert.deepEqual(config.indexes.map(({ config: index }) => index.name).toSorted(), [
    'crm_customers_active_registration_uk',
    'crm_customers_tenant_customer_uk',
    'crm_customers_tenant_name_id_idx',
  ]);

  const contactConfig = getTableConfig(contacts);
  assert.equal(contactConfig.enableRLS, true);
  assert.deepEqual(contactConfig.policies.map(({ name }) => name).toSorted(), [
    'crm_contacts_tenant_delete',
    'crm_contacts_tenant_insert',
    'crm_contacts_tenant_select',
    'crm_contacts_tenant_update',
  ]);
  assert.deepEqual(contactConfig.indexes.map(({ config: index }) => index.name).toSorted(), [
    'crm_contacts_active_customer_name_id_idx',
    'crm_contacts_active_primary_uk',
    'crm_contacts_tenant_contact_uk',
    'crm_contacts_tenant_customer_contact_uk',
  ]);
  assert.deepEqual(
    contactConfig.foreignKeys.map((foreignKey) => foreignKey.getName()),
    ['crm_contacts_customer_fk'],
  );
  assert.equal(contactConfig.foreignKeys[0]?.onDelete, 'restrict');
  assert.deepEqual(contactConfig.checks.map(({ name }) => name).toSorted(), [
    'crm_contacts_name_ck',
    'crm_contacts_version_ck',
  ]);

  const dealConfig = getTableConfig(deals);
  assert.equal(dealConfig.enableRLS, true);
  assert.deepEqual(dealConfig.policies.map(({ name }) => name).toSorted(), [
    'crm_deals_tenant_legal_entity_delete',
    'crm_deals_tenant_legal_entity_insert',
    'crm_deals_tenant_legal_entity_select',
    'crm_deals_tenant_legal_entity_update',
  ]);
  assert.deepEqual(dealConfig.indexes.map(({ config: index }) => index.name).toSorted(), [
    'crm_deals_active_scope_customer_updated_id_idx',
    'crm_deals_active_scope_updated_id_idx',
    'crm_deals_tenant_legal_entity_deal_uk',
  ]);
  assert.deepEqual(dealConfig.foreignKeys.map((foreignKey) => foreignKey.getName()).toSorted(), [
    'crm_deals_contact_fk',
    'crm_deals_customer_fk',
  ]);
  assert.equal(
    dealConfig.foreignKeys.every(({ onDelete }) => onDelete === 'restrict'),
    true,
  );
  assert.deepEqual(dealConfig.checks.map(({ name }) => name).toSorted(), [
    'crm_deals_description_ck',
    'crm_deals_expected_close_date_ck',
    'crm_deals_expected_value_ck',
    'crm_deals_status_ck',
    'crm_deals_title_ck',
    'crm_deals_version_ck',
  ]);
});
