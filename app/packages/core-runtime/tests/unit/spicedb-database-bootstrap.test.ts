import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSpiceDbDatabaseBootstrapConfig } from '../../../../scripts/postgres/spicedb-database-config.mts';

const extractSchema = (source: string): string =>
  source.slice('schema: |-\n'.length, source.indexOf('\nrelationships: |-')).trimEnd();

test('accepts a distinct SpiceDB role and database on the administrative server', () => {
  assert.deepEqual(
    parseSpiceDbDatabaseBootstrapConfig({
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://spicedb:p%40ssword@db:5432/spicedb',
    }),
    {
      adminUrl: 'postgresql://db:admin@db:5432/db',
      database: 'spicedb',
      password: 'p@ssword',
      user: 'spicedb',
    },
  );
});

test('rejects unsafe SpiceDB database bootstrap targets', () => {
  for (const environment of [
    {},
    {
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://postgres:secret@db:5432/spicedb',
    },
    {
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://spicedb:secret@other-db:5432/spicedb',
    },
    {
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_URL: 'postgresql://spicedb:secret@db:5432/ontos',
    },
  ]) {
    assert.throws(() => parseSpiceDbDatabaseBootstrapConfig(environment));
  }
});

test('keeps the stage bootstrap schema aligned without development relationships', async () => {
  const development = await readFile(
    new URL('../../spicedb/bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  const stage = await readFile(
    new URL('../../spicedb/stage-bootstrap.yaml', import.meta.url),
    'utf-8',
  );
  assert.equal(stage.trimEnd(), `schema: |-\n${extractSchema(development)}`);
  assert.doesNotMatch(stage, /relationships:|assertions:/u);
});
