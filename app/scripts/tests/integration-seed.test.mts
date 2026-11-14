import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
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
