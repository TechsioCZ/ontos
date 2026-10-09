import { Array as EffectArray, Order } from 'effect';
import { COMMERCE_MARKET_CATALOG_SCHEMA_NAME, COMMERCE_MARKET_CATALOG_TABLE_INVENTORY } from './schema.ts';

const expectedCatalog = COMMERCE_MARKET_CATALOG_TABLE_INVENTORY.map(
  (tableName) => `${COMMERCE_MARKET_CATALOG_SCHEMA_NAME}.${tableName}`,
);

export const compareCommerceMarketCatalog = (qualifiedTableNames: readonly string[]) => {
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
