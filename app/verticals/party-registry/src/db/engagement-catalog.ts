import { compareTableCatalog } from './compare-table-catalog.ts';
import { CONTACTS_SCHEMA_NAME, CONTACTS_TABLE_INVENTORY } from './engagement-schema.ts';

export const expectedContactsTableCatalog = CONTACTS_TABLE_INVENTORY.map(
  (tableName) => `${CONTACTS_SCHEMA_NAME}.${tableName}`,
);

export const compareContactsCatalog = (qualifiedTableNames: readonly string[]) =>
  compareTableCatalog(expectedContactsTableCatalog, qualifiedTableNames);
