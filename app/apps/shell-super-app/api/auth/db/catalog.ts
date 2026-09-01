import { AUTH_SCHEMA_NAME, AUTH_TABLE_INVENTORY } from './schema.ts';

export const expectedAuthTableCatalog = AUTH_TABLE_INVENTORY.map(
  (tableName) => `${AUTH_SCHEMA_NAME}.${tableName}`,
);

export interface AuthCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const compareAuthCatalog = (
  qualifiedTableNames: readonly string[],
): AuthCatalogDifference => {
  const actual = new Set(qualifiedTableNames);
  const expected = new Set(expectedAuthTableCatalog);

  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    unexpected: [...actual].filter((name) => !expected.has(name)).toSorted(),
  };
};
