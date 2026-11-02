import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { searchIndexEntries } from './schema.ts';

/** Normalize only this check's formatting, qualifications and PostgreSQL's inferred text casts. */
const normalizeSearchDocumentCheck = (definition: string) =>
  definition
    .replace(/^CHECK\s*/u, '')
    .replaceAll('"core"."search_index_entries".', '')
    .replaceAll(/"(?<identifier>[a-z_]+)"/gu, '$<identifier>')
    .replaceAll('::text', '')
    .replaceAll(/\b(?:COALESCE|AND|OR|FALSE)\b/gu, (keyword) => keyword.toLowerCase())
    .replaceAll(/[()\s]/gu, '');

export const coreSearchDocumentConstraintMatches = (definition: string) => {
  const expected = getTableConfig(searchIndexEntries).checks.find(
    ({ name }) => name === 'core_search_index_entries_document_ck',
  );
  return (
    expected !== undefined &&
    normalizeSearchDocumentCheck(definition) ===
      normalizeSearchDocumentCheck(new PgDialect().sqlToQuery(expected.value).sql)
  );
};
