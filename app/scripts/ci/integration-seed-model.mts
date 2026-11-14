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
  readonly purpose: string;
  readonly jobName: string;
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

export class SeedRole extends Schema.Class<SeedRole>('SeedRole')({
  name: Schema.NonEmptyString,
  superuser: Schema.Boolean,
  inherit: Schema.Boolean,
  createRole: Schema.Boolean,
  createDb: Schema.Boolean,
  login: Schema.Boolean,
  replication: Schema.Boolean,
  bypassRls: Schema.Boolean,
  connectionLimit: Schema.Int,
  validUntil: Schema.NullOr(Schema.String),
}) {}

export class SeedMembership extends Schema.Class<SeedMembership>('SeedMembership')({
  role: Schema.String,
  member: Schema.String,
  grantor: Schema.String,
  admin: Schema.Boolean,
  inherit: Schema.Boolean,
  set: Schema.Boolean,
}) {}
export class SeedSetting extends Schema.Class<SeedSetting>('SeedSetting')({
  role: Schema.NullOr(Schema.String),
  database: Schema.NullOr(Schema.String),
  value: Schema.String,
}) {}
export class SeedJournal extends Schema.Class<SeedJournal>('SeedJournal')({
  table: Schema.String,
  rows: Schema.Int,
}) {}
export class DatabaseEvidence extends Schema.Class<DatabaseEvidence>('DatabaseEvidence')({
  name: Schema.NonEmptyString,
  fingerprint: Schema.String,
  journals: Schema.Array(SeedJournal),
}) {}
export class SeedDatabase extends Schema.Class<SeedDatabase>('SeedDatabase')({
  evidence: DatabaseEvidence,
  archive: Schema.String.check(Schema.isPattern(/^database-[0-9]+\.dump$/u)),
  digest: Schema.String,
}) {}
export class SeedManifest extends Schema.Class<SeedManifest>('SeedManifest')({
  version: Schema.Literal(1),
  sourceRevision: Schema.String,
  workflowRun: Schema.String,
  postgresVersion: Schema.String,
  roles: Schema.Array(SeedRole),
  memberships: Schema.Array(SeedMembership),
  settings: Schema.Array(SeedSetting),
  databases: Schema.Array(SeedDatabase),
  spiceSchema: Schema.String,
  spiceRelationships: Schema.Array(Schema.Never),
  regeneratedTables: Schema.Array(Schema.Literal(SEAL_TABLE)),
}) {}
export const manifestJson = Schema.fromJsonString(SeedManifest, { space: 2 });

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
export const schemaFingerprint = (dump: string) => sha256(dump.replace(/^\\(?:un)?restrict .*\n/gmu, ''));

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
