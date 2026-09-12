import { COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME, COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY } from './schema.ts';

const expectedCommerceCustomerContextTableCatalog = COMMERCE_CUSTOMER_CONTEXT_TABLE_INVENTORY.map(
  (tableName) => `${COMMERCE_CUSTOMER_CONTEXT_SCHEMA_NAME}.${tableName}`,
);

export interface TableCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const compareCommerceCustomerContextCatalog = (
  qualifiedTableNames: readonly string[],
): TableCatalogDifference => {
  const expected = new Set(expectedCommerceCustomerContextTableCatalog);
  const actual = new Set(qualifiedTableNames);
  return {
    missing: expectedCommerceCustomerContextTableCatalog.filter((name) => !actual.has(name)),
    unexpected: qualifiedTableNames.filter((name) => !expected.has(name)).toSorted(),
  };
};
