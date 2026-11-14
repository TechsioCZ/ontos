import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { expect, it } from 'effect-rstest';

import { coreSearchDocumentConstraintMatches } from '../../src/db/search-document-constraint.ts';
import { searchIndexEntries } from '../../src/db/schema.ts';

it('the verifier accepts the schema-owned v2 constraint but not old, missing, numeric or unbounded variants', () => {
  const check = getTableConfig(searchIndexEntries).checks.find(
    ({ name }) => name === 'core_search_index_entries_document_ck',
  );
  if (check === undefined) {
    throw new Error('Missing schema-owned search document constraint');
  }
  const definition = new PgDialect().sqlToQuery(check.value).sql;
  expect(coreSearchDocumentConstraintMatches(definition)).toBe(true);
  for (const invalid of [
    definition.replace('10818202', '40000'),
    definition.replace('10818202', '10818203'),
    definition.replace(`'"2"'::jsonb`, `'2'::jsonb`),
    definition.replace('schemaVersion', 'schemaversion'),
    `${definition} or true`,
    '',
  ]) {
    expect(coreSearchDocumentConstraintMatches(invalid)).toBe(false);
  }
});
