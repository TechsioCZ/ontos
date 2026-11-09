import { fileURLToPath } from 'node:url';

import {
  IsolatedNativeDatabaseError,
  makeIsolatedNativeDatabaseFixture,
} from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { ConfigProvider, Crypto, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import { preparePartyStructuredNames } from '../../scripts/prepare-party-structured-names.mts';
import { makePartyDatabase } from '../../src/db/client.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  // `PgClient.makeClient` opens the raw preparation client, so the suite owns its Reactivity.
  Layer.provideMerge(Reactivity.layer),
);

/**
 * The upgrade history the snapshot constraint ships into. The isolated fixture allowlist has no Party
 * structured-names purpose, so this suite reuses the reviewed Party verification-removal purpose, which
 * carries no behavior of its own beyond the empty-database baseline.
 */
const fixturePurpose = 'party-verification-removal';
const baselineFolders = [
  '20260903174425_yummy_glorian',
  '20260904104109_nebulous_cardiac',
  '20260914161805_marvelous_spirit',
  '20261019115249_official_identifier_original_input',
  '20261020063911_party-gateway-scope-rls',
  '20261020113551_legal-entity-scope',
] as const;
const structuredNamesFolder = '20261105082358_flashy_gravity';

// Every member the prepared legacy snapshot must still carry, in addition to the added null keys.
const preparedSnapshotKeys = [
  'businessName',
  'firstName',
  'lastName',
  'names',
  'officialIdentifiers',
  'policyVersion',
  'provenance',
  'sourceRecordRefs',
  'validFrom',
] as const;

const preparedCandidateSnapshotSchema = Schema.Struct({
  businessName: Schema.optionalKey(Schema.Json),
  firstName: Schema.optionalKey(Schema.Json),
  lastName: Schema.optionalKey(Schema.Json),
  names: Schema.optionalKey(Schema.Json),
  officialIdentifiers: Schema.optionalKey(Schema.Json),
  policyVersion: Schema.optionalKey(Schema.Json),
  provenance: Schema.optionalKey(Schema.Json),
  sourceRecordRefs: Schema.optionalKey(Schema.Json),
  validFrom: Schema.optionalKey(Schema.Json),
});

const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(preparedCandidateSnapshotSchema));
const decodeSnapshotMembers = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface CandidateCaseRow extends Readonly<Record<string, string>> {
  readonly snapshot: string;
  readonly state: string;
}

const expectLegacySnapshotPrepared = (
  row: CandidateCaseRow,
  expected: {
    readonly officialIdentifiers: readonly unknown[];
    readonly provenance: unknown;
    readonly sourceRecordRefs: readonly string[];
    readonly validFrom: string;
  },
) => {
  expect(Object.keys(decodeSnapshotMembers(row.snapshot)).toSorted()).toEqual([...preparedSnapshotKeys].toSorted());
  const snapshot = decodeSnapshot(row.snapshot);
  expect(snapshot.names).toEqual(['Legacy Display Name']);
  expect(snapshot.provenance).toEqual(expected.provenance);
  expect(snapshot.validFrom).toBe(expected.validFrom);
  expect(snapshot.policyVersion).toBe('party-exact-claims.v1');
  expect(snapshot.sourceRecordRefs).toEqual(expected.sourceRecordRefs);
  expect(snapshot.officialIdentifiers).toEqual(expected.officialIdentifiers);
  expect(snapshot.firstName).toBeNull();
  expect(snapshot.lastName).toBeNull();
  expect(snapshot.businessName).toBeNull();
};

const expectPartialSnapshotPrepared = (
  row: CandidateCaseRow,
  expected: { readonly provenance: unknown; readonly validFrom: string },
) => {
  const snapshot = decodeSnapshot(row.snapshot);
  expect(snapshot.firstName).toBe('Ada');
  expect(snapshot.lastName).toBeNull();
  expect(snapshot.businessName).toBeNull();
  expect(snapshot.names).toEqual(['Ada Lovelace']);
  expect(snapshot.provenance).toEqual(expected.provenance);
  expect(snapshot.validFrom).toBe(expected.validFrom);
};

it.layer(nativeServices, { excludeTestServices: true })('party structured names preparation', (suite) => {
  suite.effect('adds absent structured name keys losslessly before the snapshot constraint applies', () =>
    Effect.gen(function* partyStructuredNamesUpgrade() {
      const refused = yield* makeIsolatedNativeDatabaseFixture({ mode: 'empty', purpose: fixturePurpose }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production' }),
        ),
        Effect.flip,
      );
      expect(Schema.is(IsolatedNativeDatabaseError)(refused)).toBe(true);
      if (Schema.is(IsolatedNativeDatabaseError)(refused)) {
        expect(refused.reason).toBe('Isolated native database fixtures are forbidden in deployed environments');
      }
      const isolated = yield* makeIsolatedNativeDatabaseFixture({ mode: 'empty', purpose: fixturePurpose });
      yield* isolated.migrateCoreSchema();
      const { executor: admin } = yield* makePartyDatabase(isolated.connections.admin);
      const client = yield* PgClient.makeClient({ url: Redacted.make(isolated.connections.admin.connectionString) });
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-party-structured-names-' });
      const ownerDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
      const copyMigration = Effect.fn('PartyStructuredNamesPreparation.copyMigration')(function* copyMigration(
        folder: string,
      ) {
        yield* fs.makeDirectory(`${directory}/${folder}`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/migration.sql`, `${directory}/${folder}/migration.sql`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/snapshot.json`, `${directory}/${folder}/snapshot.json`);
      });
      yield* Effect.forEach(baselineFolders, copyMigration, { discard: true });
      const options = {
        migrationsFolder: directory,
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations_party',
      };
      yield* migrate(admin, options);

      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const legacyCaseId = yield* crypto.randomUUIDv4();
      const partialCaseId = yield* crypto.randomUUIDv4();
      const currentCaseId = yield* crypto.randomUUIDv4();
      const validFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2024-03-04T05:06:07.000Z')).toISOString();
      const provenance = { method: 'DOCUMENT', source: 'structured-names-preparation-fixture' };
      const officialIdentifiers = [
        {
          identifierTypeKey: 'ICO',
          namespace: 'CZ:ICO',
          normalizedValue: '01000004',
          // An unknown legacy member: the preparation must keep it untouched.
          verificationState: 'VERIFIED',
        },
      ];
      const sourceRecordRefs = [`party.registry:${legacyCaseId}`];
      const legacySnapshot = encodeSnapshot({
        names: ['Legacy Display Name'],
        officialIdentifiers,
        policyVersion: 'party-exact-claims.v1',
        provenance,
        sourceRecordRefs,
        validFrom,
      });
      const partialSnapshot = encodeSnapshot({ firstName: 'Ada', names: ['Ada Lovelace'], provenance, validFrom });
      yield* admin.execute(
        sql`insert into party.duplicate_candidate_cases
          (candidate_case_id,tenant_id,candidate_fingerprint,evaluation_fingerprint,candidate_snapshot,
           evaluated_evidence,match_rule_version,lifecycle_state,revision)
          values (${legacyCaseId},${tenantId},${'1'.repeat(64)},${'2'.repeat(64)},${legacySnapshot}::jsonb,
            '[]'::jsonb,'party-exact-claims.v1','NEEDS_EVIDENCE',3),
            (${partialCaseId},${tenantId},${'3'.repeat(64)},${'4'.repeat(64)},${partialSnapshot}::jsonb,
            '[]'::jsonb,'party-exact-claims.v1','OPEN',1)`,
        'objects',
      );
      // Every column except the snapshot is compared as text, so identity, state, revision, fingerprints
      // and timestamps must match exactly before and after the preparation.
      const readCase = Effect.fn('PartyStructuredNamesPreparation.readCase')(function* readCase(
        candidateCaseId: string,
      ) {
        const rows = yield* admin.execute<CandidateCaseRow>(
          sql`select (to_jsonb(candidate) - 'candidate_snapshot')::text as state,
                candidate.candidate_snapshot::text as snapshot
              from party.duplicate_candidate_cases as candidate
              where candidate.candidate_case_id = ${candidateCaseId}`,
          'objects',
        );
        const [row] = rows;
        if (row === undefined) {
          return yield* Effect.die('The seeded Party candidate case row is missing');
        }
        return row;
      });
      const [absentBefore] = yield* admin.execute<{ readonly absent: boolean }>(
        sql`select jsonb_typeof(candidate_snapshot -> 'firstName') is null as absent
            from party.duplicate_candidate_cases where candidate_case_id = ${legacyCaseId}`,
        'objects',
      );
      // The legacy row is exactly the shape the new CHECK rejects: the structured key is absent.
      expect(absentBefore?.absent).toBe(true);
      const legacyBefore = yield* readCase(legacyCaseId);
      const partialBefore = yield* readCase(partialCaseId);

      expect(yield* preparePartyStructuredNames(client)).toBe('prepared');

      const legacyAfter = yield* readCase(legacyCaseId);
      const partialAfter = yield* readCase(partialCaseId);
      expect(legacyAfter.state).toBe(legacyBefore.state);
      expect(partialAfter.state).toBe(partialBefore.state);
      expectLegacySnapshotPrepared(legacyAfter, { officialIdentifiers, provenance, sourceRecordRefs, validFrom });
      expectPartialSnapshotPrepared(partialAfter, { provenance, validFrom });

      // A second preparation is a committed no-op: no row is rewritten and every byte is unchanged.
      expect(yield* preparePartyStructuredNames(client)).toBe('unchanged');
      const legacySecond = yield* readCase(legacyCaseId);
      const partialSecond = yield* readCase(partialCaseId);
      expect(legacySecond.state).toBe(legacyAfter.state);
      expect(legacySecond.snapshot).toBe(legacyAfter.snapshot);
      expect(partialSecond.state).toBe(partialAfter.state);
      expect(partialSecond.snapshot).toBe(partialAfter.snapshot);

      yield* copyMigration(structuredNamesFolder);
      yield* migrate(admin, options);
      const [journal] = yield* admin.execute<{ readonly count: number }>(
        sql`select count(*)::integer as count from drizzle.__drizzle_migrations_party`,
        'objects',
      );
      expect(journal?.count).toBe(baselineFolders.length + 1);
      const [constraint] = yield* admin.execute<{ readonly definition: string }>(
        sql`select pg_get_constraintdef(oid) as definition from pg_constraint
            where conrelid = 'party.duplicate_candidate_cases'::regclass
              and conname = 'party_duplicate_cases_snapshot_ck'`,
        'objects',
      );
      const definition = constraint?.definition.replaceAll(/\s+/gu, '');
      expect(definition).toContain("->>'firstName'");
      expect(definition).not.toContain("->'names'");
      // The constraint change accepts the prepared rows without rewriting them.
      const legacyConverged = yield* readCase(legacyCaseId);
      const partialConverged = yield* readCase(partialCaseId);
      expect(legacyConverged.state).toBe(legacyAfter.state);
      expect(legacyConverged.snapshot).toBe(legacyAfter.snapshot);
      expect(partialConverged.state).toBe(partialAfter.state);
      expect(partialConverged.snapshot).toBe(partialAfter.snapshot);

      // A genuinely current snapshot (no `names` member) is only insertable after the constraint change,
      // and the preparation must leave it byte-identical.
      const currentSnapshot = encodeSnapshot({
        businessName: null,
        firstName: null,
        lastName: null,
        provenance,
        validFrom,
      });
      yield* admin.execute(
        sql`insert into party.duplicate_candidate_cases
          (candidate_case_id,tenant_id,candidate_fingerprint,evaluation_fingerprint,candidate_snapshot,
           evaluated_evidence,match_rule_version,lifecycle_state,revision)
          values (${currentCaseId},${tenantId},${'5'.repeat(64)},${'6'.repeat(64)},${currentSnapshot}::jsonb,
            '[]'::jsonb,'party-exact-claims.v1','OPEN',1)`,
        'objects',
      );
      const currentBefore = yield* readCase(currentCaseId);
      expect(yield* preparePartyStructuredNames(client)).toBe('unchanged');
      const currentAfter = yield* readCase(currentCaseId);
      expect(currentAfter.state).toBe(currentBefore.state);
      expect(currentAfter.snapshot).toBe(currentBefore.snapshot);
    }),
  );
});
