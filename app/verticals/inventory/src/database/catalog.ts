import { Array as EffectArray, Order } from 'effect';

import { INVENTORY_SCHEMA_NAME, INVENTORY_TABLE_INVENTORY } from './schema.ts';

const expectedCatalog = INVENTORY_TABLE_INVENTORY.map((tableName) => `${INVENTORY_SCHEMA_NAME}.${tableName}`);

export const compareInventoryCatalog = (qualifiedTableNames: readonly string[]) => {
  const expected = new Set(expectedCatalog);
  const actual = new Set(qualifiedTableNames);
  return {
    missing: EffectArray.sort(
      [...expected].filter((tableName) => !actual.has(tableName)),
      Order.String,
    ),
    unexpected: EffectArray.sort(
      [...actual].filter((tableName) => !expected.has(tableName)),
      Order.String,
    ),
  };
};
