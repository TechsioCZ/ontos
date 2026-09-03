import { PARTY_SCHEMA_NAME, PARTY_TABLE_INVENTORY } from './schema.ts';

export const expectedPartyTableCatalog = PARTY_TABLE_INVENTORY.map(
  (tableName) => `${PARTY_SCHEMA_NAME}.${tableName}`,
);

export interface PartyCatalogDifference {
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export const comparePartyCatalog = (
  qualifiedTableNames: readonly string[],
): PartyCatalogDifference => {
  const actual = new Set(qualifiedTableNames);
  const expected = new Set(expectedPartyTableCatalog);
  return {
    missing: [...expected].filter((name) => !actual.has(name)).toSorted(),
    unexpected: [...actual].filter((name) => !expected.has(name)).toSorted(),
  };
};
