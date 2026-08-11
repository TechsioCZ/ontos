import assert from 'node:assert/strict';
import test from 'node:test';
import { isTable } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schemaExports from '../../src/db/schema.ts';
import { CRM_SCHEMA_NAME, CRM_TABLE_INVENTORY, crmSchema, customers } from '../../src/db/schema.ts';

test('owns the exact typed CRM Customer table inventory', () => {
  assert.equal(crmSchema.schemaName, CRM_SCHEMA_NAME);
  assert.deepEqual(CRM_TABLE_INVENTORY, ['customers']);
  assert.deepEqual(Object.values(schemaExports).filter(isTable), [customers]);
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
});
