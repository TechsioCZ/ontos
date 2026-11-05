import { fileURLToPath } from 'node:url';

import {
  IsolatedNativeDatabaseError,
  makeIsolatedNativeDatabaseFixture,
} from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { ConfigProvider, Crypto, DateTime, Effect, FileSystem, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makePartyDatabase } from '../../src/db/client.ts';
import { parties, partyOfficialIdentifiers } from '../../src/db/schema.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const baselineFolders = [
  '20260903174425_yummy_glorian',
  '20260904104109_nebulous_cardiac',
  '20260914161805_marvelous_spirit',
  '20261019115249_official_identifier_original_input',
  '20261020063911_party-gateway-scope-rls',
  '20261020113551_legal-entity-scope',
] as const;
const forwardFolders = ['20261105154254_young_magik', '20261105154619_left_vin_gonzales'] as const;

it.layer(nativeServices, { excludeTestServices: true })('verification removal upgrade', (suite) => {
  suite.effect('upgrades populated disposable assertions without rewriting acceptance or provenance', () =>
    Effect.gen(function* populatedVerificationRemoval() {
      const refused = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'party-verification-removal',
      }).pipe(
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
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'party-verification-removal',
      });
      yield* isolated.migrateCoreSchema();
      const { executor: admin } = yield* makePartyDatabase(isolated.connections.admin);
      expect(isolated.connections.admin.database).toBe(isolated.connections.runtime.database);
      expect(isolated.connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-party-verification-upgrade-' });
      const ownerDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
      for (const folder of baselineFolders) {
        yield* fs.makeDirectory(`${directory}/${folder}`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/migration.sql`, `${directory}/${folder}/migration.sql`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/snapshot.json`, `${directory}/${folder}/snapshot.json`);
      }
      const options = {
        migrationsSchema: 'drizzle',
        migrationsTable: '__drizzle_migrations_party',
        migrationsFolder: directory,
      };
      yield* migrate(admin, options);
      const crypto = yield* Crypto.Crypto;
      const tenantId = yield* crypto.randomUUIDv4();
      const partyId = yield* crypto.randomUUIDv4();
      const identifierId = yield* crypto.randomUUIDv4();
      const invocationId = yield* crypto.randomUUIDv4();
      const principalId = yield* crypto.randomUUIDv4();
      const validFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'));
      yield* admin.insert(parties).values({ partyId, tenantId, currentType: 'ORGANIZATION' });
      // This scoped old-schema producer is intentionally explicit: current metadata has no verification column.
      yield* admin.execute(
        sql`
        insert into party.party_official_identifiers (
          official_identifier_id,tenant_id,party_id,identifier_type_key,namespace,normalized_value,
          original_input_digits,accepted_by_action_invocation_id,accepted_by_principal_id,policy_version,
          provenance_method,provenance_source,valid_from,verification_state,verified_at,verified_by_principal_id
        ) values (
          ${identifierId},${tenantId},${partyId},'ICO','CZ:ICO','01000004','1000004',
          ${invocationId},${principalId},'fixture-acceptance.v1','DOCUMENT','disposable-upgrade-fixture',
          ${validFrom},'VERIFIED',${validFrom},${principalId}
        )`,
        'objects',
      );
      yield* admin.execute(
        sql`
        insert into party.party_identifier_claims
          (tenant_id,identifier_type_key,namespace,normalized_value,party_id,official_identifier_id)
        values (${tenantId},'ICO','CZ:ICO','01000004',${partyId},${identifierId})`,
        'objects',
      );
      const readAssertion = () =>
        admin
          .select()
          .from(partyOfficialIdentifiers)
          .where(eq(partyOfficialIdentifiers.officialIdentifierId, identifierId));
      const [before] = yield* readAssertion();
      expect(before?.acceptedByActionInvocationId).toBe(invocationId);
      const readSecurity = () =>
        admin.execute<{ readonly forced: boolean; readonly rls: boolean; readonly foreignKeys: number }>(
          sql`
        select c.relforcerowsecurity as forced,c.relrowsecurity as rls,
          (select count(*)::integer from pg_constraint fk where fk.conrelid=c.oid and fk.contype='f') as "foreignKeys"
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='party' and c.relname='party_official_identifiers'`,
          'objects',
        );
      const securityBefore = yield* readSecurity();
      expect(securityBefore).toEqual([{ forced: true, rls: true, foreignKeys: 3 }]);
      for (const folder of forwardFolders) {
        yield* fs.makeDirectory(`${directory}/${folder}`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/migration.sql`, `${directory}/${folder}/migration.sql`);
        yield* fs.copyFile(`${ownerDirectory}/${folder}/snapshot.json`, `${directory}/${folder}/snapshot.json`);
      }
      yield* migrate(admin, options);
      const [after] = yield* readAssertion();
      expect(after).toEqual(before);
      expect(after?.originalInputDigits).toBe('1000004');
      expect(after?.provenanceSource).toBe('disposable-upgrade-fixture');
      expect(after?.acceptedByPrincipalId).toBe(principalId);
      expect(yield* readSecurity()).toEqual(securityBefore);
      const [removed] = yield* admin.execute<{ readonly columns: number; readonly claimsAbsent: boolean }>(
        sql`
        select
          (select count(*)::integer from information_schema.columns
           where table_schema='party' and table_name in
             ('party_fact_assertions','party_official_identifiers','party_contact_points','party_contact_point_purposes')
           and column_name in ('verification_state','verification_method','verifier_reference','verified_at','verified_by_principal_id')) as columns,
          to_regclass('party.party_identifier_claims') is null as "claimsAbsent"`,
        'objects',
      );
      expect(removed).toEqual({ columns: 0, claimsAbsent: true });
      const journal = () =>
        admin.execute<{ readonly count: number }>(
          sql`select count(*)::integer as count from drizzle.__drizzle_migrations_party`,
          'objects',
        );
      expect((yield* journal())[0]?.count).toBe(8);
      yield* migrate(admin, options);
      expect((yield* journal())[0]?.count).toBe(8);
      expect(yield* readAssertion()).toEqual([before]);
    }),
  );
});
