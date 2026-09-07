import { CONTACTS_SCHEMA_NAME, CONTACTS_TABLE_INVENTORY } from './engagement-schema.ts';

export const expectedContactsTableCatalog = CONTACTS_TABLE_INVENTORY.map(
  (tableName) => `${CONTACTS_SCHEMA_NAME}.${tableName}`,
);

export interface ContactsCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const compareContactsCatalog = (
  qualifiedTableNames: readonly string[],
): ContactsCatalogDifference => {
  const actual = new Set(qualifiedTableNames);
  const expected = new Set(expectedContactsTableCatalog);

  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    unexpected: [...actual].filter((name) => !expected.has(name)).toSorted(),
  };
};
