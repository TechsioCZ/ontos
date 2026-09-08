import { AUTH_SCHEMA_NAME, AUTH_TABLE_INVENTORY } from './schema.ts';

export const expectedAuthTableCatalog = AUTH_TABLE_INVENTORY.map(
  (tableName) => `${AUTH_SCHEMA_NAME}.${tableName}`,
);

export const compareAuthCatalog = (qualifiedTableNames: readonly string[]) => {
  const actual = new Set(qualifiedTableNames);
  const expected = new Set(expectedAuthTableCatalog);

  return {
    missing: [...expected.difference(actual)].toSorted(),
    unexpected: [...actual.difference(expected)].toSorted(),
  };
};
