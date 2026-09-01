import { CORE_SCHEMA_NAME, CORE_TABLE_INVENTORY } from './schema.ts';

export type CatalogEntry =
  | {
      readonly kind: 'schema';
      readonly schemaName: string;
      readonly tableName: null;
    }
  | {
      readonly kind: 'table';
      readonly schemaName: string;
      readonly tableName: string;
    };

export interface CatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const expectedCoreTableCatalog = CORE_TABLE_INVENTORY.map(
  (tableName) => `${CORE_SCHEMA_NAME}.${tableName}`,
);

export const compareApplicationCatalog = (entries: readonly CatalogEntry[]): CatalogDifference => {
  const actualTables = new Set(
    entries
      .filter(
        (entry): entry is Extract<CatalogEntry, { readonly kind: 'table' }> =>
          entry.kind === 'table',
      )
      .map((entry) => `${entry.schemaName}.${entry.tableName}`),
  );
  const expectedTables = new Set(expectedCoreTableCatalog);
  const missing = [...expectedTables].filter((name) => !actualTables.has(name)).toSorted();
  const unexpectedTables = [...actualTables].filter((name) => !expectedTables.has(name)).toSorted();
  const unexpectedSchemas = entries
    .filter((entry) => entry.kind === 'schema')
    .map((entry) => `${entry.schemaName}.*`)
    .toSorted();

  return {
    missing,
    unexpected: [...unexpectedSchemas, ...unexpectedTables].toSorted(),
  };
};
