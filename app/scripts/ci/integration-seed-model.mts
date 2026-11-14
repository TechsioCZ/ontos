import { createHash } from 'node:crypto';

import { Effect, Schema } from 'effect';

export class IntegrationSeedError extends Schema.TaggedError<IntegrationSeedError>()('IntegrationSeedError', {
  reason: Schema.String,
}) {}

export const seedFailure = (reason: string) => new IntegrationSeedError({ reason });
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
export const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const SEAL_TABLE = 'trust.scope_sealing_keys';
export const COMMERCE_URL_KEY = 'INTEGRATION_SEED_COMMERCE_AUTH_DATABASE_URL';
export const MANIFEST_FILE = 'manifest.json';
export const FRESH_JOB = 'Database, Migration, RLS, Authorization, and Outbox Integration';

/** These tests must retain their own empty/historical database and migration/recovery path. */
export const MUST_MIGRATE_TESTS = [
  'scripts/integration/migration-equivalence.test.mts',
  'scripts/integration/migrator-runtime-owner-access.test.mts',
  'scripts/integration/stage-recovery-lifecycle.test.mts',
  'scripts/integration/vat-deploy-sequence.test.mts',
  'packages/core-runtime/tests/integration/action-authority-v2-migration.test.ts',
  'packages/core-runtime/tests/integration/application-composition-authority-migration.test.ts',
  'packages/core-runtime/tests/integration/application-composition-durable-work-migration.test.ts',
  'packages/core-runtime/tests/integration/auth-namespace-migration.test.ts',
  'packages/core-runtime/tests/integration/contacts-identity-migration.test.ts',
  'packages/core-runtime/tests/integration/search-v2-cutover-migration.test.ts',
  'verticals/commerce-customer-context/tests/integration/stage-recovery-lane15-lifecycle.test.ts',
  'verticals/commerce-customer-context/tests/integration/organization-profile-ico-migration-postgres.test.ts',
  'verticals/work-tasks/tests/integration/assignment-migration.test.mts',
  'verticals/merchandise/tests/integration/tax-classification-migration-postgres.test.ts',
  'verticals/finance-billing/tests/integration/vat-classification-migration-postgres.test.ts',
  'verticals/party-registry/tests/integration/official-identifier-original-input-migration.test.ts',
  'verticals/party-registry/tests/integration/organization-migration-fixture.test.ts',
  'verticals/party-registry/tests/integration/verification-removal-migration.test.ts',
];

/** Rows that run the files above, from their own fresh database preparation; they never restore a seed. */
export const FRESH_DATABASE_JOB = /^Fresh Database Integration\b/u;

/**
 * A test file must keep the job's own fresh preparation only when it migrates or recovers that database itself
 * (MUST_MIGRATE_TESTS and the name rule below). Every other integration test either uses the job database as it is
 * or derives its own databases from it: a schema-only clone (makeIsolatedNativeDatabaseFixture) or an empty
 * database it migrates itself. For those the restored seed is the same database: its roles, grants, owners,
 * schema fingerprints and journals are checked on restore. So the refusal is by file, never by job: a job that runs
 * the root suite or a large owner's suite may seed once it names exactly the files it runs.
 */
export const assertSeedConsumer = (input: {
  readonly jobName: string;
  readonly purpose: string;
  readonly rootSuite: boolean;
  readonly testFiles: readonly string[];
}) => {
  const forbidden = input.testFiles.find((file) => {
    const relative = file
      .replaceAll('\\', '/')
      .replace(/^.*\/app\//u, '')
      .replace(/^app\//u, '');
    return MUST_MIGRATE_TESTS.includes(relative) || /(?:migration|stage-recovery|fresh-database)/u.test(relative);
  });
  // A root-suite job must name its files: the root suite carries migration-equivalence and recovery tests.
  const unnamedRootSuite = input.rootSuite && input.testFiles.length === 0;
  const excludedJob = input.jobName === FRESH_JOB || FRESH_DATABASE_JOB.test(input.jobName);
  return input.purpose !== 'ordinary-tests' || unnamedRootSuite || excludedJob || forbidden !== undefined
    ? Effect.fail(seedFailure(`Seed restore forbidden for migration/recovery coverage: ${forbidden ?? input.jobName}`))
    : Effect.void;
};

export const SeedRoleSchema = Schema.Struct({
  bypassRls: Schema.Boolean,
  connectionLimit: Schema.Int,
  createDb: Schema.Boolean,
  createRole: Schema.Boolean,
  inherit: Schema.Boolean,
  login: Schema.Boolean,
  name: Schema.NonEmptyString,
  replication: Schema.Boolean,
  superuser: Schema.Boolean,
  /** PostgreSQL's VALID UNTIL; absent when the role never expires. */
  validUntil: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
});
export type SeedRole = typeof SeedRoleSchema.Type;

export const SeedMembershipSchema = Schema.Struct({
  admin: Schema.Boolean,
  grantor: Schema.String,
  inherit: Schema.Boolean,
  member: Schema.String,
  role: Schema.String,
  set: Schema.Boolean,
});
export type SeedMembership = typeof SeedMembershipSchema.Type;
export const SeedSettingSchema = Schema.Struct({
  /** Absent for a setting that applies in every database. */
  database: Schema.OptionFromNullOr(Schema.String),
  /** Absent for a setting that applies to every role. */
  role: Schema.OptionFromNullOr(Schema.String),
  value: Schema.String,
});
export type SeedSetting = typeof SeedSettingSchema.Type;
export const SeedJournalSchema = Schema.Struct({
  rows: Schema.Int,
  table: Schema.String,
});
export type SeedJournal = typeof SeedJournalSchema.Type;
export const DatabaseEvidenceSchema = Schema.Struct({
  fingerprint: Schema.String,
  journals: Schema.Array(SeedJournalSchema),
  name: Schema.NonEmptyString,
});
export type DatabaseEvidence = typeof DatabaseEvidenceSchema.Type;
export const SeedDatabaseSchema = Schema.Struct({
  archive: Schema.String.check(Schema.isPattern(/^database-[0-9]+\.dump$/u)),
  digest: Schema.String,
  evidence: DatabaseEvidenceSchema,
});
export type SeedDatabase = typeof SeedDatabaseSchema.Type;
export const SeedManifestSchema = Schema.Struct({
  databases: Schema.Array(SeedDatabaseSchema),
  memberships: Schema.Array(SeedMembershipSchema),
  postgresVersion: Schema.String,
  regeneratedTables: Schema.Array(Schema.Literal(SEAL_TABLE)),
  roles: Schema.Array(SeedRoleSchema),
  settings: Schema.Array(SeedSettingSchema),
  sourceRevision: Schema.String,
  spiceRelationships: Schema.Array(Schema.Never),
  spiceSchema: Schema.String,
  version: Schema.Literal(1),
  workflowRun: Schema.String,
});
export type SeedManifest = typeof SeedManifestSchema.Type;
export const manifestJson = Schema.fromJsonString(SeedManifestSchema, { space: 2 });

export const assertDatabaseEvidence = (expected: DatabaseEvidence, actual: DatabaseEvidence) => {
  if (actual.name !== expected.name || actual.fingerprint !== expected.fingerprint) {
    return Effect.fail(
      seedFailure(`Seed schema fingerprint mismatch for ${expected.name}; refusing migrations fallback`),
    );
  }
  const sameJournals =
    expected.journals.length === actual.journals.length &&
    expected.journals.every((journal, index) => {
      const restored = actual.journals[index];
      return journal.table === restored?.table && journal.rows === restored.rows;
    });
  return sameJournals
    ? Effect.void
    : Effect.fail(seedFailure(`Seed migration journal row counts differ for ${expected.name}`));
};

/** pg_dump adds random restrict keys; everything else, including owners/ACLs/policies, is hashed. */
export const schemaFingerprint = (dump: string) => sha256(dump.replaceAll(/^\\(?:un)?restrict .*\n/gmu, ''));

/** Exactly the migration's HMAC pad construction, but fresh in each consumer. Never export the pads. */
export const REGENERATE_SEAL_SQL = `DO $$
DECLARE
  k bytea := pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, 'UTF8'));
  b bytea := k || pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');
  i bytea := b;
  o bytea := b;
BEGIN
  IF EXISTS (SELECT 1 FROM trust.scope_sealing_keys) THEN
    RAISE EXCEPTION 'Seed unexpectedly contains scope sealing keys';
  END IF;
  FOR n IN 0..63 LOOP
    i := pg_catalog.set_byte(i, n, pg_catalog.get_byte(b, n) # 54);
    o := pg_catalog.set_byte(o, n, pg_catalog.get_byte(b, n) # 92);
  END LOOP;
  INSERT INTO trust.scope_sealing_keys (key_id, inner_pad, outer_pad) VALUES (1, i, o);
END $$;`;
