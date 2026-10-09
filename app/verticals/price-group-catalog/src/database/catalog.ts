import { Array as EffectArray, Order } from 'effect';

import { PRICE_GROUP_CATALOG_SCHEMA_NAME, PRICE_GROUP_CATALOG_TABLE_INVENTORY } from './schema.ts';

const expectedPriceGroupCatalog = PRICE_GROUP_CATALOG_TABLE_INVENTORY.map(
  (tableName) => `${PRICE_GROUP_CATALOG_SCHEMA_NAME}.${tableName}`,
);

export const comparePriceGroupCatalog = (qualifiedTableNames: readonly string[]) => {
  const expected = new Set(expectedPriceGroupCatalog);
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
