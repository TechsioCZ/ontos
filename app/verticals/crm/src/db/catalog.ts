import { CRM_SCHEMA_NAME, CRM_TABLE_INVENTORY } from './schema.ts';

export const expectedCrmTableCatalog = CRM_TABLE_INVENTORY.map(
  (tableName) => `${CRM_SCHEMA_NAME}.${tableName}`,
);

export interface CrmCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const compareCrmCatalog = (qualifiedTableNames: readonly string[]): CrmCatalogDifference => {
  const actual = new Set(qualifiedTableNames);
  const expected = new Set(expectedCrmTableCatalog);

  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    unexpected: [...actual].filter((name) => !expected.has(name)).toSorted(),
  };
};
