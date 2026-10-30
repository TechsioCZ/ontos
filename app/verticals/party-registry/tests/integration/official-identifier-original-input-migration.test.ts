import { fileURLToPath } from 'node:url';

import { ReadRuntime, runAction, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { Crypto, DateTime, Effect, FileSystem, Layer, Redacted, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import {
  OfficialIdentifierInputSchema,
  normalizeOfficialIdentifier,
} from '../../shared/domain/identifier-contracts.ts';
import { makePartyRef } from '../../shared/domain/identity-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { addPartyOfficialIdentifierAction } from '../../src/actions/add-party-official-identifier.action.ts';
import { partyOfficialIdentifierHistoryRead } from '../../src/api/party-official-identifier-history.read.ts';
import { makePartyDatabase } from '../../src/db/client.ts';
import { parties, partyOfficialIdentifiers, PARTY_TABLES } from '../../src/db/schema.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const baselineFolders = [
  '20260903174425_yummy_glorian',
  '20260904104109_nebulous_cardiac',
  '20260914161805_marvelous_spirit',
] as const;

it.layer(nativeServices, { excludeTestServices: true })('original ICO input upgrade', (suite) => {
  suite.effect('upgrades a genuinely populated canonical-only Party history without inventing source digits', () =>
    Effect.gen(function* populatedIdentifierUpgrade() {
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'stabilization-1281-party-legacy',
      });
      yield* isolated.migrateCoreSchema();
      const { executor: admin } = yield* makePartyDatabase(isolated.connections.admin);
      const { executor: database } = yield* makePartyDatabase(isolated.connections.runtime);
      const [identity] = yield* database.execute<{ readonly database: string }>(
        sql`select current_database() as database`,
        'objects',
      );
      expect(identity?.database).toBe(isolated.connections.runtime.database);
      expect(identity?.database).toBe(isolated.connections.admin.database);
      expect(identity?.database.startsWith('ontos_test_party_gateway_')).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      const baselineDirectory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-party-1281-baseline-' });
      const ownerDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
      for (const folder of baselineFolders) {
        yield* fs.makeDirectory(`${baselineDirectory}/${folder}`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/migration.sql`, `${baselineDirectory}/${folder}/migration.sql`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/snapshot.json`, `${baselineDirectory}/${folder}/snapshot.json`);
      }
      const migrationOptions = { migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations_party' };
      yield* migrate(admin, { ...migrationOptions, migrationsFolder: baselineDirectory });
      // Reproduce only Party's normal runtime privileges inside this owned empty database.
      // Existing table CHECKs, append-only triggers and forced RLS remain installed unchanged.
      const runtimeRole = sql.identifier(isolated.connections.runtime.user);
      yield* admin.execute(sql`grant usage on schema party to ${runtimeRole}`, 'objects');
      for (const table of PARTY_TABLES) {
        yield* admin.execute(sql`grant select,insert,update,delete on table ${table} to ${runtimeRole}`, 'objects');
      }
      const [beforeColumn] = yield* admin.execute<{ readonly count: number }>(
        sql`select count(*)::integer as count from information_schema.columns where table_schema='party' and table_name='party_official_identifiers' and column_name='original_input_digits'`,
        'objects',
      );
      expect(beforeColumn?.count).toBe(0);
      const snapshot = yield* makeApplicationCompositionSnapshotFixture(
        [ultramodernApiMarker.appId],
        ultramodernApiMarker.buildMarker,
      );
      yield* isolated.publishInitialComposition(snapshot);
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          actionKeys: [addPartyOfficialIdentifierAction.descriptor.actionKey],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
          compositionRevision: snapshot.composition.revision,
          runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
        }),
        (resource) => resource.close().pipe(Effect.orDie),
      );
      const crypto = yield* Crypto.Crypto;
      const partyId = yield* crypto.randomUUIDv4();
      const identifierId = yield* crypto.randomUUIDv4();
      const oldInvocationId = yield* crypto.randomUUIDv4();
      const identifier = normalizeOfficialIdentifier(
        yield* Schema.decodeUnknownEffect(OfficialIdentifierInputSchema)({
          identifierType: 'ICO',
          value: '1000004',
          verification: 'UNVERIFIED',
        }),
      );
      // Test-only old acceptance producer: actual decoded rules and the immutable baseline
      // table/forced-RLS contract. No current Add code or new source column can run yet.
      yield* database.transaction((transaction) =>
        Effect.gen(function* oldRuntimeAcceptance() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${fixture.tenantId}, true)`, 'objects');
          yield* transaction
            .insert(parties)
            .values({ partyId, tenantId: fixture.tenantId, currentType: 'ORGANIZATION' });
          // Current Drizzle metadata emits every current column (including DEFAULT for
          // the not-yet-existing source column), so this compatibility-only producer names
          // the actual old columns explicitly and keeps every value parameterized.
          yield* transaction.execute(
            sql`
            insert into party.party_official_identifiers (
              official_identifier_id,tenant_id,party_id,identifier_type_key,namespace,normalized_value,
              accepted_by_action_invocation_id,accepted_by_principal_id,policy_version,
              provenance_method,provenance_source,valid_from,verification_state
            ) values (
              ${identifierId},${fixture.tenantId},${partyId},${identifier.identifierType},${identifier.namespace},${identifier.normalizedValue},
              ${oldInvocationId},${fixture.manager.principalId},${'party-official-identifier.v1'},
              ${'MANUAL'},${'pre-migration-acceptance'},${DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'))},${identifier.verification}
            )
          `,
            'objects',
          );
        }),
      );
      const [baseline] = yield* admin
        .select({
          officialIdentifierId: partyOfficialIdentifiers.officialIdentifierId,
          normalizedValue: partyOfficialIdentifiers.normalizedValue,
          invocationId: partyOfficialIdentifiers.acceptedByActionInvocationId,
        })
        .from(partyOfficialIdentifiers)
        .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierId));
      expect(baseline).toEqual({
        officialIdentifierId: identifierId,
        normalizedValue: '01000004',
        invocationId: oldInvocationId,
      });
      const [security] = yield* database.execute<{
        readonly bypass: boolean;
        readonly superuser: boolean;
        readonly rls: boolean;
        readonly forced: boolean;
      }>(
        sql`select r.rolbypassrls as bypass,r.rolsuper as superuser,c.relrowsecurity as rls,c.relforcerowsecurity as forced from pg_roles r cross join pg_class c join pg_namespace n on n.oid=c.relnamespace where r.rolname=current_user and n.nspname='party' and c.relname='party_official_identifiers'`,
        'objects',
      );
      expect(security).toEqual({ bypass: false, superuser: false, rls: true, forced: true });
      const foreignTenantId = yield* crypto.randomUUIDv4();
      const hidden = yield* database.transaction((transaction) =>
        Effect.gen(function* oldRuntimeIsolation() {
          yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${foreignTenantId}, true)`, 'objects');
          return yield* transaction
            .select({ id: partyOfficialIdentifiers.officialIdentifierId })
            .from(partyOfficialIdentifiers)
            .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierId));
        }),
      );
      expect(hidden).toEqual([]);
      const journalCount = () =>
        admin.execute<{ readonly count: number }>(
          sql`select count(*)::integer as count from drizzle.__drizzle_migrations_party`,
          'objects',
        );
      expect((yield* journalCount())[0]?.count).toBe(3);
      // Copy the exact new owner migration only after the canonical-only row exists.
      // Keeping this four-folder chain fixed also avoids applying future unrelated owner migrations.
      const forwardFolder = '20261019115249_official_identifier_original_input';
      yield* fs.makeDirectory(`${baselineDirectory}/${forwardFolder}`);
      yield* fs.copyFile(
        `${ownerDirectory}/${forwardFolder}/migration.sql`,
        `${baselineDirectory}/${forwardFolder}/migration.sql`,
      );
      yield* fs.copyFile(
        `${ownerDirectory}/${forwardFolder}/snapshot.json`,
        `${baselineDirectory}/${forwardFolder}/snapshot.json`,
      );
      yield* migrate(admin, { ...migrationOptions, migrationsFolder: baselineDirectory });
      expect((yield* journalCount())[0]?.count).toBe(4);
      yield* migrate(admin, { ...migrationOptions, migrationsFolder: baselineDirectory });
      expect((yield* journalCount())[0]?.count).toBe(4);
      const [upgraded] = yield* admin
        .select()
        .from(partyOfficialIdentifiers)
        .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierId));
      assert.isOk(upgraded);
      expect(upgraded.originalInputDigits).toBe(null);
      expect(upgraded.normalizedValue).toBe('01000004');
      const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        ...fixture.manager,
        legalEntityId: fixture.legalEntityId,
      });
      const context = yield* Layer.build(fixture.layer);
      const readRuntime = yield* ReadRuntime.pipe(Effect.provideContext(context));
      const partyRef = makePartyRef(fixture.tenantId, partyId);
      const history = () =>
        readRuntime
          .runRead({
            registration: partyOfficialIdentifierHistoryRead,
            input: { partyRef },
            principal,
            transport: { correlationId: 'populated-identifier-upgrade' },
          })
          .pipe(Effect.provideContext(context));
      const oldHistory = yield* history();
      expect(oldHistory.items).toHaveLength(1);
      expect(oldHistory.items[0]?.originalInputDigits).toBe(null);
      const reused = yield* runAction({
        registration: addPartyOfficialIdentifierAction,
        payload: {
          identifier: { identifierType: 'ICO', value: '01000004', verification: 'UNVERIFIED' },
          partyRef,
          provenanceMethod: 'MANUAL',
          provenanceSource: 'post-migration-intake',
          validFrom: '2020-01-01T00:00:00.000Z',
        },
        principal,
        transport: {
          correlationId: 'populated-identifier-reuse',
          idempotencyKey: yield* crypto.randomUUIDv4(),
          targetModuleKey: 'party.registry',
        },
      }).pipe(Effect.provideContext(context));
      expect(reused.officialIdentifierRef.resourceId).toBe(identifierId);
      const retained = yield* admin
        .select()
        .from(partyOfficialIdentifiers)
        .where(
          and(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId), eq(partyOfficialIdentifiers.partyId, partyId)),
        );
      expect(retained).toHaveLength(1);
      expect(retained[0]).toEqual(upgraded);
      expect((yield* history()).items[0]?.originalInputDigits).toBe(null);
    }),
  );
});
