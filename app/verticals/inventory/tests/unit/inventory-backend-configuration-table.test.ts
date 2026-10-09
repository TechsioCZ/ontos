import { getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { inventoryBackendConfigurations } from '../../src/persistence/inventory-backend-configuration-table.ts';

it('owns one tenant-isolated Inventory Backend selection per Customer Configuration', () => {
  const config = getTableConfig(inventoryBackendConfigurations);

  expect(`${config.schema}.${config.name}`).toBe('inventory.backend_configurations');
  expect(config.enableRLS).toBe(true);
  expect(config.indexes.map((index) => index.config.name)).toEqual(
    expect.arrayContaining([
      'inventory_backend_configurations_scope_id_uk',
      'inventory_backend_configurations_customer_uk',
    ]),
  );
  expect(config.checks.map((constraint) => constraint.name)).toEqual(
    expect.arrayContaining([
      'inventory_backend_configurations_backend_ck',
      'inventory_backend_configurations_capability_ck',
      'inventory_backend_configurations_revision_ck',
    ]),
  );
  expect(config.policies.map((policy) => policy.for)).toEqual(['select', 'insert', 'update', 'delete']);
});
