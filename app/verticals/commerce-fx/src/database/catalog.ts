import { Array as EffectArray, Order } from 'effect';
import { COMMERCE_FX_SCHEMA_NAME, COMMERCE_FX_TABLE_INVENTORY } from './schema.ts';

export const expectedCommerceFxCatalog = COMMERCE_FX_TABLE_INVENTORY.map(
  (tableName) => `${COMMERCE_FX_SCHEMA_NAME}.${tableName}`,
);

export const compareCommerceFxCatalog = (qualifiedTableNames: readonly string[]) => {
  const expected = new Set(expectedCommerceFxCatalog);
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
