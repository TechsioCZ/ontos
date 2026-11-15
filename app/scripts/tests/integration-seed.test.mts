import { readFileSync } from 'node:fs';

import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  BUILD_DEPENDENT_TABLES,
  buildDependentStateRefusal,
  schemaDifference,
  seedFailure,
  seedRestoreRefusal,
  FRESH_JOB,
  MUST_MIGRATE_TESTS,
  SEAL_TABLE,
  SeedDatabaseSchema,
  assertDatabaseEvidence,
  assertSeedConsumer,
  manifestJson,
  schemaFingerprint,
} from '../ci/integration-seed-model.mts';
import type { DatabaseEvidence, SeedJournal, SeedManifest } from '../ci/integration-seed-model.mts';

const PRIMARY_DATABASE = 'ontos_ci';
const NORMAL_JOB = 'Catalog Integration';
const journal: SeedJournal = { rows: 42, table: 'drizzle.__drizzle_migrations_core' };
const evidence: DatabaseEvidence = { fingerprint: 'a'.repeat(64), journals: [journal], name: PRIMARY_DATABASE };
const consumer = { jobName: NORMAL_JOB, purpose: 'ordinary-tests', rootSuite: false, testFiles: [] };
const manifest: SeedManifest = {
  databases: [{ archive: 'database-0.dump', digest: 'c'.repeat(64), evidence }],
  memberships: [],
  postgresVersion: '18.6',
  regeneratedTables: [SEAL_TABLE],
  roles: [],
  settings: [],
  sourceRevision: 'b'.repeat(40),
  spiceRelationships: [],
  spiceSchema: 'definition principal {}',
  version: 1,
  workflowRun: '123',
};

it.effect('round-trips the seed manifest without introducing credentials', () =>
  Effect.gen(function* manifestRoundTrip() {
    const encoded = yield* Schema.encodeEffect(manifestJson)(manifest);
    expect(yield* Schema.decodeEffect(manifestJson)(encoded)).toEqual(manifest);
    expect(encoded).not.toContain('password');
    expect(encoded).not.toContain('inner_pad');
    return yield* Effect.void;
  }),
);

it.effect('rejects malformed manifest JSON and unsafe archive paths', () =>
  Effect.gen(function* rejectBadManifest() {
    const malformed = yield* Schema.decodeEffect(manifestJson)('{').pipe(Effect.exit);
    expect(Exit.isFailure(malformed)).toBe(true);
    const invalid = yield* Schema.decodeUnknownEffect(SeedDatabaseSchema)({
      archive: '../stolen.dump',
      digest: 'bad',
      evidence,
    }).pipe(Effect.exit);
    expect(Exit.isFailure(invalid)).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('allows ordinary tests and refuses every must-migrate file before restore', () =>
  Effect.gen(function* migrationCoverage() {
    yield* assertSeedConsumer(consumer);
    for (const filename of MUST_MIGRATE_TESTS) {
      const result = yield* assertSeedConsumer({ ...consumer, testFiles: [filename] }).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
    }
    for (const purpose of ['migration-proof', 'recovery-proof', 'fresh-database']) {
      expect(Exit.isFailure(yield* assertSeedConsumer({ ...consumer, purpose }).pipe(Effect.exit))).toBe(true);
    }
    for (const jobName of [FRESH_JOB, 'Fresh Database Integration (1/2)']) {
      expect(Exit.isFailure(yield* assertSeedConsumer({ ...consumer, jobName }).pipe(Effect.exit))).toBe(true);
    }
    // A root-suite job seeds only when it names exactly the files it runs, none of them a must-migrate file.
    expect(Exit.isFailure(yield* assertSeedConsumer({ ...consumer, rootSuite: true }).pipe(Effect.exit))).toBe(true);
    const rootFile =
      '/home/runner/work/ontos/ontos/app/scripts/integration/application-composition-native-upgrade.test.mts';
    yield* assertSeedConsumer({
      ...consumer,
      jobName: 'Root Integration (1/4)',
      rootSuite: true,
      testFiles: [rootFile],
    });
    for (const jobName of [
      'Commerce Customer Context Integration (1/7)',
      'Core Runtime Integration (1/2)',
      'Party Registry Integration',
    ]) {
      yield* assertSeedConsumer({ ...consumer, jobName });
    }
    expect(
      Exit.isFailure(
        yield* assertSeedConsumer({
          ...consumer,
          jobName: 'Root Integration (2/4)',
          rootSuite: true,
          testFiles: [rootFile, '/w/app/scripts/integration/migration-equivalence.test.mts'],
        }).pipe(Effect.exit),
      ),
    ).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('fails closed on a restored schema fingerprint or migration-journal mismatch', () =>
  Effect.gen(function* equivalenceGuard() {
    yield* assertDatabaseEvidence(evidence, evidence);
    const altered = { ...evidence, fingerprint: 'd'.repeat(64) };
    const fingerprintError = yield* assertDatabaseEvidence(evidence, altered).pipe(Effect.flip);
    expect(fingerprintError.reason).toContain('fingerprint mismatch');
    const missing = { ...evidence, journals: [] };
    const countError = yield* assertDatabaseEvidence(evidence, missing).pipe(Effect.flip);
    expect(countError.reason).toContain('journal row counts');
    const changed = { ...evidence, journals: [{ ...journal, rows: 41 }] };
    expect(Exit.isFailure(yield* assertDatabaseEvidence(evidence, changed).pipe(Effect.exit))).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('ignores only randomized pg_dump restrict markers, not ownership or grant differences', () =>
  Effect.gen(function* stableSchemaFingerprint() {
    const ddl = 'CREATE SCHEMA core;\nALTER SCHEMA core OWNER TO admin;\n';
    expect(schemaFingerprint(`\\restrict first\n${ddl}\\unrestrict first\n`)).toBe(
      schemaFingerprint(`\\restrict second\n${ddl}\\unrestrict second\n`),
    );
    expect(schemaFingerprint(ddl)).not.toBe(schemaFingerprint(`${ddl}GRANT USAGE ON SCHEMA core TO runtime;\n`));
    return yield* Effect.void;
  }),
);

it('names the failed seed step in the error message, so the log shows which step failed', () => {
  const failure = seedFailure('pnpm CI seed operation failed; child diagnostics withheld to protect credentials');
  expect(failure.message).toBe('pnpm CI seed operation failed; child diagnostics withheld to protect credentials');
  expect(String(failure)).toContain('pnpm CI seed operation failed');
});

it('restores a seed from another run or revision under the same key, never one another PostgreSQL dumped', () => {
  const dumped = { postgresVersion: '18.6', sourceRevision: 'a'.repeat(40), workflowRun: '1' };
  // The cache key names every input of the migrated database; a later run on a later commit reuses it.
  expect(seedRestoreRefusal(dumped, { postgresVersion: '18.6' })).toBeUndefined();
  expect(seedRestoreRefusal(dumped, { postgresVersion: '18.7' })).toContain('PostgreSQL 18.6');
});

it('names the schema lines a restored database lacks or gained, without the per-run restrict keys', () => {
  const seed = '\\restrict aaa\nCREATE TABLE a ();\nGRANT SELECT ON a TO r;\n\\unrestrict aaa\n';
  const restored = '\\restrict bbb\nCREATE TABLE a ();\nGRANT SELECT ON a TO s;\n\\unrestrict bbb\n';
  expect(schemaDifference(seed, seed)).toBe('0 line(s) only in the seed, 0 only after restore\nby kind: ');
  const difference = schemaDifference(seed, restored);
  expect(difference).toContain('- GRANT SELECT ON a TO r;');
  expect(difference).toContain('+ GRANT SELECT ON a TO s;');
  expect(difference).toContain('by kind: GRANT SELECT 1');
  expect(difference).not.toContain('restrict');
});

it('fingerprints a schema regardless of the order pg_dump emits it and of its per-run restrict keys', () => {
  const first =
    '\\restrict k1\nCREATE TABLE a (id int);\nCREATE TABLE b (id int);\nGRANT SELECT ON a TO r;\n\\unrestrict k1\n';
  const reordered =
    '\\restrict k2\nGRANT SELECT ON a TO r;\nCREATE TABLE b (id int);\nCREATE TABLE a (id int);\n\\unrestrict k2\n';
  expect(schemaFingerprint(reordered)).toBe(schemaFingerprint(first));
  // A changed column, constraint or grant still changes it.
  expect(schemaFingerprint(first.replace('TO r', 'TO s'))).not.toBe(schemaFingerprint(first));
  expect(schemaFingerprint(first.replace('b (id int)', 'b (id bigint)'))).not.toBe(schemaFingerprint(first));
});

const selectPolicy = (roles: string) =>
  `CREATE POLICY p ON s.t FOR SELECT TO ${roles} USING ((tenant_id = (current_setting('ontos.tenant_id'::text))::uuid));\n`;
const insertPolicy = (roles: string) => `CREATE POLICY p ON s.t FOR INSERT TO ${roles} WITH CHECK (true);\n`;
const deletePolicy = (roles: string) => `CREATE POLICY p ON s.t FOR DELETE TO ${roles} USING (false);\n`;

it('fingerprints a policy by the set of roles it applies to, not the order their OIDs list them in', () => {
  expect(schemaFingerprint(selectPolicy('writer, ontos_runtime'))).toBe(
    schemaFingerprint(selectPolicy('ontos_runtime, writer')),
  );
  expect(schemaFingerprint(selectPolicy('writer, ontos_runtime'))).not.toBe(
    schemaFingerprint(selectPolicy('ontos_runtime')),
  );
  expect(schemaFingerprint(insertPolicy('b, a'))).toBe(schemaFingerprint(insertPolicy('a, b')));
  expect(schemaFingerprint(deletePolicy('b, a'))).toBe(schemaFingerprint(deletePolicy('a, b')));
});

it("refuses a seed that carries another run's Application Composition, and a count it could not read", () => {
  const none = BUILD_DEPENDENT_TABLES.map((table): readonly [string, number] => [table, 0]);
  expect(buildDependentStateRefusal(none)).toBeUndefined();
  expect(buildDependentStateRefusal([['core.application_composition_authority', 1], ...none.slice(1)])).toContain(
    'core.application_composition_authority: 1 rows',
  );
  expect(buildDependentStateRefusal([['core.application_composition_authority', Number.NaN]])).toBeDefined();
});

it('dumps before the Outbox Worker host proof publishes a composition, and checks for none on restore too', () => {
  const source = readFileSync(new URL('../ci/integration-seed.mts', import.meta.url), 'utf-8');
  const produce = source.slice(source.indexOf('const produce = '), source.indexOf('const restore = '));
  const check = produce.indexOf('yield* assertNoBuildDependentState;');
  const dump = produce.indexOf('dumpDatabase(name, index, directory, containerDirectory)');
  const worker = produce.indexOf("'scripts/prove-outbox-worker-host-artifact.sh'");
  expect(check).toBeGreaterThan(-1);
  expect(check).toBeLessThan(dump);
  expect(dump).toBeLessThan(worker);
  const proof = source.slice(source.indexOf('const runFullProof = '), source.indexOf('const produce = '));
  expect(proof).not.toContain('prove-outbox-worker-host-artifact.sh');
  const restore = source.slice(source.indexOf('const restore = '));
  expect(restore.indexOf('yield* assertNoBuildDependentState;')).toBeGreaterThan(restore.indexOf('restoreDatabase('));
});
