import { Array as EffectArray, Order } from 'effect';
import { PAYMENT_TERM_CATALOG_SCHEMA_NAME, PAYMENT_TERM_CATALOG_TABLE_INVENTORY } from './schema.ts';

const expectedPaymentTermCatalog = PAYMENT_TERM_CATALOG_TABLE_INVENTORY.map(
  (tableName) => `${PAYMENT_TERM_CATALOG_SCHEMA_NAME}.${tableName}`,
);

export const comparePaymentTermCatalog = (qualifiedTableNames: readonly string[]) => {
  const expected = new Set(expectedPaymentTermCatalog);
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
