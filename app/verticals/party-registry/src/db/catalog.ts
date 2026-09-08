import { compareTableCatalog } from './compare-table-catalog.ts';
import { PARTY_SCHEMA_NAME, PARTY_TABLE_INVENTORY } from './schema.ts';

export const expectedPartyTableCatalog = PARTY_TABLE_INVENTORY.map(
  (tableName) => `${PARTY_SCHEMA_NAME}.${tableName}`,
);

export const comparePartyCatalog = (qualifiedTableNames: readonly string[]) =>
  compareTableCatalog(expectedPartyTableCatalog, qualifiedTableNames);
