import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Effect, FileSystem, Redacted } from 'effect';
import { expect, it } from 'effect-rstest';

import { parseSpiceDbDatabaseBootstrapConfig } from '../../src/install/spicedb-database-config.ts';
import { spicedbBootstrapYaml } from '../../src/install/spicedb-bootstrap-schema.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

/*
 * The engine an environment starts from is a file this repository ships, and it must be exactly the
 * schema Core serves (CUTOVER-PLAN §3.6, O62.3). Both bootstrap files are generated from the constant, so
 * these cases are the drift check: a hand edit, a stale file after a schema change, or a returned
 * `relationships:` block all fail here instead of at a stage promotion.
 */

const bootstrapFiles = ['bootstrap.yaml', 'stage-bootstrap.yaml'] as const;

/** The schema a bootstrap file carries, read back out of its YAML block. */
const schemaOf = (source: string): string => {
  const start = source.indexOf('schema: |-\n');
  if (start === -1) {
    return '';
  }
  return source
    .slice(start + 'schema: |-\n'.length)
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n')
    .trimEnd();
};

it('bootstraps the fixed SpiceDB role and database with the exact configured password', () => {
  expect(
    parseSpiceDbDatabaseBootstrapConfig({
      DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db',
      SPICEDB_DATABASE_PASSWORD: Redacted.make(' p@ss:w/o%rd#? '),
    }),
  ).toEqual({
    adminUrl: 'postgresql://db:admin@db:5432/db',
    database: 'spicedb',
    password: ' p@ss:w/o%rd#? ',
    user: 'spicedb',
  });
});

it('rejects unsafe SpiceDB database bootstrap configuration', () => {
  for (const environment of [
    {},
    { DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db' },
    { DATABASE_ADMIN_URL: 'postgresql://db:admin@db:5432/db', SPICEDB_DATABASE_PASSWORD: Redacted.make('') },
    { DATABASE_ADMIN_URL: 'mysql://db:admin@db:3306/db', SPICEDB_DATABASE_PASSWORD: Redacted.make('secret') },
    { DATABASE_ADMIN_URL: 'postgresql://spicedb:admin@db:5432/db', SPICEDB_DATABASE_PASSWORD: Redacted.make('secret') },
  ]) {
    expect(() => parseSpiceDbDatabaseBootstrapConfig(environment)).toThrow();
  }
});

it('generates a schema-only bootstrap file and never a grant', () => {
  const generated = spicedbBootstrapYaml('definition access_human {}\n');
  expect(generated).toBe(
    [
      '# Generated from ONTOS_SPICEDB_SCHEMA (packages/core-runtime/src/permissions/schema.ts).',
      '# Do not edit by hand: change the schema constant and regenerate (see',
      '# src/install/spicedb-bootstrap-schema.ts, pinned by tests/unit/spicedb-database-bootstrap.test.ts).',
      '#',
      '# Schema only. Core projects every relationship from PostgreSQL intent, so a bootstrap file never',
      '# carries development or stage grants, and the engine reads this file only when its datastore is empty.',
      'schema: |-',
      '  definition access_human {}',
      '',
    ].join('\n'),
  );
  // A bootstrap file is the schema and nothing else: a relationship block would be a grant nobody recorded.
  expect(generated).not.toMatch(/relationships:|assertions:/u);
  expect(schemaOf(generated)).toBe('definition access_human {}');
});

it.layer(NodeFileSystem.layer)('SpiceDB bootstrap sources', (suite) => {
  suite.effect('pins both bootstrap files to the schema Core serves', () =>
    Effect.gen(function* pinsBootstrapFiles() {
      const fs = yield* FileSystem.FileSystem;
      for (const name of bootstrapFiles) {
        const source = yield* fs.readFileString(fileURLToPath(new URL(`../../spicedb/${name}`, import.meta.url)));
        // Byte for byte: the file is the generator's output, so an edit or a stale file fails here.
        expect(source).toBe(spicedbBootstrapYaml());
        expect(source).not.toMatch(/relationships:|assertions:/u);
        expect(schemaOf(source)).toBe(ONTOS_SPICEDB_SCHEMA.trimEnd());
      }
    }),
  );

  suite.effect('reports a hand-edited bootstrap file as drift', () =>
    Effect.gen(function* reportsDrift() {
      const fs = yield* FileSystem.FileSystem;
      const development = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/bootstrap.yaml', import.meta.url)),
      );
      // The negative control: the same file with one added grant is no longer the generated file, which
      // is exactly what the pin above compares.
      const edited = `${development}relationships: |-\n  tenant:t#member@principal:p\n`;
      expect(edited).not.toBe(spicedbBootstrapYaml());
      expect(edited).toMatch(/relationships:/u);
    }),
  );

  suite.effect('carries the v2 definitions the engine decides on', () =>
    Effect.gen(function* carriesV2Definitions() {
      const fs = yield* FileSystem.FileSystem;
      const stage = yield* fs.readFileString(
        fileURLToPath(new URL('../../spicedb/stage-bootstrap.yaml', import.meta.url)),
      );
      for (const definition of ['access_human', 'agent', 'access_scope', 'access_assignment', 'access_record']) {
        expect(stage).toMatch(new RegExp(`definition ${definition} \\{`, 'u'));
      }
      for (const caveat of ['amount_ceiling', 'target_set', 'bounded_target_set']) {
        expect(stage).toMatch(new RegExp(`caveat ${caveat}\\(`, 'u'));
      }
      // The v2 relations accept a verified human and an agent, never an arbitrary principal (O46).
      expect(stage).toMatch(/relation member: access_human \|/u);
    }),
  );
});
