import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DatabaseEvidence,
  FRESH_JOB,
  MUST_MIGRATE_TESTS,
  SEAL_TABLE,
  SeedDatabase,
  SeedJournal,
  SeedManifest,
  assertDatabaseEvidence,
  assertSeedConsumer,
  manifestJson,
  schemaFingerprint,
} from '../ci/integration-seed-model.mts';

const PRIMARY_DATABASE = 'ontos_ci';
const NORMAL_JOB = 'Catalog Integration';
const journal = new SeedJournal({ table: 'drizzle.__drizzle_migrations_core', rows: 42 });
const evidence = new DatabaseEvidence({ name: PRIMARY_DATABASE, fingerprint: 'a'.repeat(64), journals: [journal] });
const consumer = { purpose: 'ordinary-tests', jobName: NORMAL_JOB, rootSuite: false, testFiles: [] };
const manifest = new SeedManifest({
  version: 1,
  sourceRevision: 'b'.repeat(40),
  workflowRun: '123',
  postgresVersion: '18.6',
  roles: [],
  memberships: [],
  settings: [],
  databases: [new SeedDatabase({ evidence, archive: 'database-0.dump', digest: 'c'.repeat(64) })],
  spiceSchema: 'definition principal {}',
  spiceRelationships: [],
  regeneratedTables: [SEAL_TABLE],
});

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
    const invalid = yield* Schema.decodeUnknownEffect(SeedDatabase)({
      evidence,
      archive: '../stolen.dump',
      digest: 'bad',
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
    for (const jobName of [
      FRESH_JOB,
      'Root Integration (1/3)',
      'Commerce Customer Context Integration (1/6)',
      'Core Runtime Integration',
      'Party Registry Integration',
    ]) {
      expect(Exit.isFailure(yield* assertSeedConsumer({ ...consumer, jobName }).pipe(Effect.exit))).toBe(true);
    }
    expect(Exit.isFailure(yield* assertSeedConsumer({ ...consumer, rootSuite: true }).pipe(Effect.exit))).toBe(true);
    return yield* Effect.void;
  }),
);

it.effect('fails closed on a restored schema fingerprint or migration-journal mismatch', () =>
  Effect.gen(function* equivalenceGuard() {
    yield* assertDatabaseEvidence(evidence, evidence);
    const altered = new DatabaseEvidence({ ...evidence, fingerprint: 'd'.repeat(64) });
    const fingerprintError = yield* assertDatabaseEvidence(evidence, altered).pipe(Effect.flip);
    expect(fingerprintError.reason).toContain('fingerprint mismatch');
    const missing = new DatabaseEvidence({ ...evidence, journals: [] });
    const countError = yield* assertDatabaseEvidence(evidence, missing).pipe(Effect.flip);
    expect(countError.reason).toContain('journal row counts');
    const changed = new DatabaseEvidence({ ...evidence, journals: [new SeedJournal({ ...journal, rows: 41 })] });
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
