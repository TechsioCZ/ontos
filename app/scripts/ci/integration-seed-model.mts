import { createHash } from 'node:crypto';

import { Array as EffectArray, Effect, Order, Schema } from 'effect';

import { loadCiMatrices } from './ci-matrices.mts';

export class IntegrationSeedError extends Schema.TaggedError<IntegrationSeedError>()('IntegrationSeedError', {
  reason: Schema.String,
}) {
  /** The reason is the message, so a failed seed step names itself in the log instead of an empty error. */
  override get message() {
    return this.reason;
  }
}

export const seedFailure = (reason: string) => new IntegrationSeedError({ reason });
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
export const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const SEAL_TABLE = 'trust.scope_sealing_keys';
export const COMMERCE_URL_KEY = 'INTEGRATION_SEED_COMMERCE_AUTH_DATABASE_URL';
export const MANIFEST_FILE = 'manifest.json';
/**
 * Tables whose rows name the unit builds of the run that wrote them: the Application Composition the Outbox Worker host
 * proof publishes, with every unit's build marker. A seed is reused by later commits whose units are built again, so
 * such rows would describe builds the consuming job does not have. A seed never carries them; each job publishes its
 * own, from its own builds, after the restore, exactly as a job that migrates does.
 */
export const BUILD_DEPENDENT_TABLES = [
  'core.application_composition_authority',
  'core.application_composition_durable_work',
  'core.application_composition_drain_abandonments',
] as const;

const heldRows = ([table, rows]: readonly [string, number]) => `${table}: ${String(rows)} rows`;

/** Why a database with rows in a build-dependent table may not become, or be used as, a seed. */
export const buildDependentStateRefusal = (counts: readonly (readonly [string, number])[]): string | undefined => {
  // A count that did not come back is treated as rows: the check never passes by not looking.
  const held = counts.filter(([, rows]) => !Number.isSafeInteger(rows) || rows > 0);
  return held.length === 0
    ? undefined
    : `Seed database holds state of this run's unit builds (${held.map(heldRows).join(', ')}); a seed carries none`;
};
export const FRESH_JOB = 'Database, Migration, RLS, Authorization, and Outbox Integration';

/**
 * The test files that must keep their own empty or historical database and its migration or recovery path:
 * "fresh-database-tests" of the gate matrices (scripts/ci/ci-matrices.mts), which also leave them out of every seeded row.
 */
export const readFreshDatabaseTests = (overlay?: string) =>
  loadCiMatrices(overlay).pipe(
    Effect.map((matrices) => matrices['fresh-database-tests']),
    Effect.mapError((cause) => seedFailure(`The fresh-database tests are unreadable: ${cause.message}`)),
  );

/** Rows that run the files above, from their own fresh database preparation; they never restore a seed. */
export const FRESH_DATABASE_JOB = /^Fresh Database Integration\b/u;

/**
 * A test file must keep the job's own fresh preparation only when it migrates or recovers that database itself
 * (readFreshDatabaseTests and the name rule below). Every other integration test either uses the job database as it is
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
}) =>
  Effect.gen(function* checkSeedConsumer() {
    const fresh = yield* readFreshDatabaseTests();
    const forbidden = input.testFiles.find((file) => {
      const relative = file
        .replaceAll('\\', '/')
        .replace(/^.*\/app\//u, '')
        .replace(/^app\//u, '');
      return fresh.includes(relative) || /(?:migration|stage-recovery|fresh-database)/u.test(relative);
    });
    // A root-suite job must name its files: the root suite carries migration-equivalence and recovery tests.
    const unnamedRootSuite = input.rootSuite && input.testFiles.length === 0;
    const excludedJob = input.jobName === FRESH_JOB || FRESH_DATABASE_JOB.test(input.jobName);
    if (input.purpose !== 'ordinary-tests' || unnamedRootSuite || excludedJob || forbidden !== undefined) {
      return yield* seedFailure(
        `Seed restore forbidden for migration/recovery coverage: ${forbidden ?? input.jobName}`,
      );
    }
    return yield* Effect.void;
  });

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

/**
 * Why a cached seed cannot be restored on this server, if it cannot. The cache key already names every input of the
 * migrated database, so a seed produced by another run or revision under the same key is the same database; only the
 * PostgreSQL server that restores it must be the one that dumped it.
 */
export const seedRestoreRefusal = (
  manifest: Pick<SeedManifest, 'postgresVersion'>,
  server: { readonly postgresVersion: string },
): string | undefined =>
  manifest.postgresVersion === server.postgresVersion
    ? undefined
    : `Seed was dumped by PostgreSQL ${manifest.postgresVersion}, not this server's ${server.postgresVersion}; rebuild the seed`;

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
/**
 * A policy's role list in the order its roles were created: pg_dump lists `TO a, b` by role OID, and a restore
 * creates the roles in another order. The set is what the policy grants, so it is compared sorted.
 */
const POLICY_ROLES = /^(?<head>CREATE POLICY .+? TO )(?<roles>[^;]+?)(?<tail> USING \(.*| WITH CHECK \(.*|;)$/u;
const sortedPolicyRoles = (dump: string) =>
  dump
    .split('\n')
    .map((line) => {
      const groups = POLICY_ROLES.exec(line)?.groups;
      if (groups?.head === undefined || groups.roles === undefined || groups.tail === undefined) {
        return line;
      }
      return `${groups.head}${EffectArray.sort(groups.roles.split(', '), Order.String).join(', ')}${groups.tail}`;
    })
    .join('\n');

/** The schema dump as fingerprinted: pg_dump's per-run `\\restrict` keys removed, policy role lists sorted. */
export const normalizedSchema = (dump: string) => sortedPolicyRoles(dump.replaceAll(/^\\(?:un)?restrict .*\n/gmu, ''));
/**
 * The fingerprint of a schema dump: every line, pg_dump's per-run `\\restrict` keys left out, in sorted order. Any
 * object, column, constraint, index, policy, grant or owner that differs changes it; the order pg_dump happens to
 * emit them in does not.
 */
export const schemaFingerprint = (dump: string) =>
  sha256(EffectArray.sort(normalizedSchema(dump).split('\n'), Order.String).join('\n'));

const lineCounts = (text: string) => {
  const lines = new Map<string, number>();
  for (const line of normalizedSchema(text).split('\n')) {
    lines.set(line, (lines.get(line) ?? 0) + 1);
  }
  return lines;
};
const linesOnlyIn = (from: Map<string, number>, other: Map<string, number>, sign: string) =>
  [...from].flatMap(([line, times]) =>
    Array.from({ length: Math.max(0, times - (other.get(line) ?? 0)) }, () => `${sign} ${line}`),
  );

/**
 * The lines only one of two schema dumps has, at most `limit` of each, so a fingerprint mismatch names what
 * differs. Schema dumps carry DDL only: no role passwords, no table data.
 */
export const schemaDifference = (expected: string, actual: string, limit = 30): string => {
  const before = lineCounts(expected);
  const after = lineCounts(actual);
  const removed = linesOnlyIn(before, after, '-');
  const added = linesOnlyIn(after, before, '+');
  // Which kinds of statement differ, so one report shows every class of difference, not only the first 30 lines.
  const kinds = new Map<string, number>();
  for (const line of removed) {
    const kind =
      /^- +(?<kind>(?:CREATE|ALTER|GRANT|REVOKE|COMMENT|SET|SELECT)\b(?: [A-Z]+)?|CONSTRAINT)/u.exec(line)?.groups
        ?.kind ?? 'other';
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  return [
    `${String(removed.length)} line(s) only in the seed, ${String(added.length)} only after restore`,
    `by kind: ${[...kinds].map(([kind, times]) => [kind, String(times)].join(' ')).join(', ')}`,
    ...removed.slice(0, limit),
    ...added.slice(0, limit),
  ].join('\n');
};

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
