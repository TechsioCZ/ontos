import { PROJECTS_SCHEMA_NAME, PROJECTS_TABLE_INVENTORY } from './schema.ts';

export const expectedProjectsTableCatalog = PROJECTS_TABLE_INVENTORY.map(
  (tableName) => `${PROJECTS_SCHEMA_NAME}.${tableName}`,
);

export interface ProjectsCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const compareProjectsCatalog = (
  qualifiedTableNames: readonly string[],
): ProjectsCatalogDifference => {
  const actual = new Set(qualifiedTableNames);
  const expected = new Set(expectedProjectsTableCatalog);

  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    unexpected: [...actual].filter((name) => !expected.has(name)).toSorted(),
  };
};
