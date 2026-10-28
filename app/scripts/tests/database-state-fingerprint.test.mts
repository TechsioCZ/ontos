import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Option, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';

import { expect, it } from 'effect-rstest';

import {
  canonicalDatabaseValue,
  DATABASE_CATALOG_QUERIES,
  DatabasePreparationRecordSchema,
  DatabaseStateFingerprintError,
  hashDatabaseState,
  parseDatabasePreparationRecord,
  planDatabasePreparation,
  recordDatabasePreparation,
} from '../postgres/database-state-fingerprint.mts';
import { isMigrationChange } from '../plan-deployment-impact.mts';

const inputsDigest = 'a'.repeat(64);
const identityFp = 'b'.repeat(64);
const stateHash = 'c'.repeat(64);
const record = { identityFp, inputsDigest, stateHash };
const authorityNotActive = 'authority-not-active';
const observation = { authorityPhase: 'active', identityFp, loginsOk: true, stateHash };

it('only permits the light path for exact prepared inputs, credentials, catalog state and an active authority', () => {
  expect(planDatabasePreparation(observation, inputsDigest, record)).toEqual({
    authorityPhase: 'active',
    light: true,
    loginsOk: true,
    reason: 'matching-preparation',
    stateHash: Option.some(stateHash),
  });
});
for (const [name, overrides, expected] of [
  ['sealed authority', { authorityPhase: 'sealed' }, authorityNotActive],
  ['migrated authority', { authorityPhase: 'migrated' }, authorityNotActive],
  ['absent authority', { authorityPhase: 'unknown' }, authorityNotActive],
  ['manual GRANT', { stateHash: 'd'.repeat(64) }, 'state-changed'],
  ['password rotation', { identityFp: 'd'.repeat(64) }, 'identity-changed'],
  ['failed login', { loginsOk: false }, 'login-unavailable'],
  ['unreadable state', { stateHash: null }, 'state-unavailable'],
  ['missing key', { identityFp: null }, 'fingerprint-key-unavailable'],
] as const) {
  it(`selects the sealed full chain for ${name}`, () => {
    const result = planDatabasePreparation({ ...observation, ...overrides }, inputsDigest, record);
    expect(result.light).toBe(false);
    expect(result.reason).toBe(expected);
  });
}
it('a new migration/input, missing record, malformed digest and force-full all prevent reuse', () => {
  expect(planDatabasePreparation(observation, 'd'.repeat(64), record).reason).toBe('inputs-changed');
  expect(planDatabasePreparation(observation, inputsDigest).light).toBe(false);
  expect(planDatabasePreparation(observation, '', record).light).toBe(false);
  expect(planDatabasePreparation(observation, inputsDigest, record, true).reason).toBe('force-full');
});
it('rejects malformed ledger evidence, never partially accepting it', () => {
  for (const value of [null, [], {}, { ...record, stateHash: null }, { ...record, identityFp: 'secret' }]) {
    expect(Option.isNone(parseDatabasePreparationRecord(value))).toBe(true);
  }
  expect(Option.getOrThrow(parseDatabasePreparationRecord(record))).toEqual(record);
});
it('is deterministic across query row, object property and ACL ordering without erasing column order', () => {
  const left = { acl: ['reader=r/admin', 'writer=w/admin'], name: 'table' };
  const right = { acl: ['writer=w/admin', 'reader=r/admin'], name: 'table' };
  expect(canonicalDatabaseValue(left)).toBe(canonicalDatabaseValue(right));
  expect(hashDatabaseState(['a', 'b'])).toBe(hashDatabaseState(['b', 'a']));
  expect(canonicalDatabaseValue(['a', 'b'])).not.toBe(canonicalDatabaseValue(['b', 'a']));
  expect(hashDatabaseState(['journal new-migration'])).not.toBe(hashDatabaseState([]));
});
it('excludes application rows, sequence counters, statistics and password verifiers from catalog queries', () => {
  const sql = Object.values(DATABASE_CATALOG_QUERIES).join('\n');
  expect(sql).not.toMatch(/from\s+(?:core|trust|auth)\./u);
  expect(sql).not.toMatch(/rolpassword|last_value|reltuples|relpages/u);
  for (const name of [
    'roles',
    'memberships',
    'settings',
    'database',
    'defaults',
    'columns',
    'policies',
    'routines',
  ] as const) {
    expect(DATABASE_CATALOG_QUERIES[name]).toBeDefined();
  }
});
it('documents mutable trust reconciliation and includes migration and database source inputs', () => {
  const manifest = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        audit: Schema.Record(Schema.String, Schema.String),
        globs: Schema.Array(Schema.String),
      }),
    ),
  )(readFileSync(new URL('../ci/database-preparation-inputs.json', import.meta.url), 'utf-8'));
  expect(manifest.audit['db:bootstrap-runtime-role']).toContain('trust.gateway_audience_roles');
  expect(manifest.globs).toContain('verticals/*/drizzle*/**');
  expect(manifest.globs).toContain('database/**');
});
for (const path of [
  'scripts/verify-core-db-schema.mts',
  'verticals/party-registry/scripts/verify-engagement-db-schema.mts',
  'packages/core-runtime/src/environment/drizzle-config.ts',
  'scripts/stage-demo-migrate.mts',
  'verticals/commerce-customer-context/drizzle-portal-auth/20261001000000_init/migration.sql',
  'verticals/commerce-customer-context/drizzle.portal-auth.config.ts',
  'verticals/commerce-customer-context/scripts/bootstrap-portal-auth-runtime-role.mts',
  'verticals/commerce-customer-context/scripts/verify-portal-auth-db-schema.mts',
  'verticals/commerce-customer-context/scripts/portal-auth-database-config.mts',
  'scripts/run-optional-commerce-portal-auth-db.mts',
  'scripts/migration-convergence-cli.mts',
  'scripts/migration-convergence.mts',
  'scripts/migration-equivalence.mts',
  'scripts/postgres/runtime-role-grants.mts',
  'database/identity-enrollment.ts',
]) {
  it(`includes the migrator for ${path}`, () => expect(isMigrationChange(path)).toBe(true));
}

const recordFixture = Effect.gen(function* createRecordFixture() {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-database-record-' });
  const output = `${directory}/database-record.json`;
  yield* fs.writeFileString(output, 'stale evidence');
  return { fs, output };
});

for (const [name, evidence] of [
  ['missing key', { ...observation, identityFp: null }],
  ['failed login', { ...observation, loginsOk: false }],
  ['unavailable state', { ...observation, stateHash: null }],
] as const) {
  it.effect(`recording ${name} is non-fatal and removes stale evidence`, () =>
    Effect.gen(function* skipUnavailableRecord() {
      const { fs, output } = yield* recordFixture;
      yield* recordDatabasePreparation({ inputsDigest, output }, Effect.succeed(evidence));
      expect(yield* fs.exists(output)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, Reactivity.layer])),
  );
}
for (const digest of ['', 'not-a-sha256']) {
  it.effect(`recording an invalid digest (${digest}) skips observation and succeeds without evidence`, () =>
    Effect.gen(function* skipInvalidInputs() {
      const { fs, output } = yield* recordFixture;
      let observed = false;
      yield* recordDatabasePreparation(
        { inputsDigest: digest, output },
        Effect.sync(() => {
          observed = true;
          return observation;
        }),
      );
      expect(observed).toBe(false);
      expect(yield* fs.exists(output)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, Reactivity.layer])),
  );
}
it.effect('a transient catalog failure is non-fatal and cannot leave ledger evidence', () =>
  Effect.gen(function* discardFailedObservation() {
    const { fs, output } = yield* recordFixture;
    yield* recordDatabasePreparation(
      { inputsDigest, output },
      Effect.fail(new DatabaseStateFingerprintError({ reason: 'statement timeout' })),
    );
    expect(yield* fs.exists(output)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, Reactivity.layer])),
);
it.effect('recording a verified preparation writes the exact ledger contract', () =>
  Effect.gen(function* writeVerifiedRecord() {
    const { fs, output } = yield* recordFixture;
    yield* recordDatabasePreparation({ inputsDigest, output }, Effect.succeed(observation));
    const written = yield* fs.readFileString(output);
    expect(Schema.decodeUnknownSync(Schema.fromJsonString(DatabasePreparationRecordSchema))(written)).toEqual(record);
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, Reactivity.layer])),
);
it.effect('an unwritable record output is non-fatal', () =>
  Effect.gen(function* skipUnwritableRecord() {
    const { output } = yield* recordFixture;
    yield* recordDatabasePreparation({ inputsDigest, output: `${output}/record.json` }, Effect.succeed(observation));
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, Reactivity.layer])),
);
