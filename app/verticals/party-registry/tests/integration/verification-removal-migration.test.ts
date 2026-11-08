// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://party.ontos.test"}
import { fileURLToPath } from 'node:url';
import { PARTY_REGISTRY_REQUEST_IDENTITY } from '@app/party-registry-identity-contracts';

import {
  IsolatedNativeDatabaseError,
  makeIsolatedNativeDatabaseFixture,
} from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { ConfigProvider, Crypto, DateTime, Effect, FileSystem, Layer, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { makePartyDatabase } from '../../src/db/client.ts';
import { partyContactPoints, partyOfficialIdentifiers } from '../../src/db/schema.ts';

import { makeGovernedContactFixture } from '../support/governed-contact.fixture.ts';
import {
  makePartyReconciliationGateway,
  preparePartyReconciliationNative,
} from '../support/party-reconciliation-native.fixture.ts';
import { partyCompositionSnapshot } from './application-composition.setup.ts';

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
const structuredNamesFolder = '20261105082358_flashy_gravity';
const forwardFolders = [
  '20261105154254_young_magik',
  '20261105154619_left_vin_gonzales',
  '20261106083603_aberrant_gauntlet',
] as const;

it.layer(nativeServices, { excludeTestServices: true })('verification removal upgrade', (suite) => {
  suite.effect(
    'preserves populated assertions and accepts governed writes and Reads after upgrade',
    () =>
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
        // Gateway redemption uses the separately journaled Contacts schema.
        yield* migrate(admin, {
          migrationsFolder: fileURLToPath(new URL('../../drizzle-contacts/', import.meta.url)),
          migrationsSchema: 'drizzle',
          migrationsTable: '__drizzle_migrations_contacts',
        });
        expect(isolated.connections.admin.database).toBe(isolated.connections.runtime.database);
        expect(isolated.connections.admin.database.startsWith('ontos_test_party_gateway_')).toBe(true);
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-party-verification-upgrade-' });
        const ownerDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
        const copyMigration = Effect.fn('VerificationRemovalUpgrade.copyMigration')(function* copyMigration(
          folder: string,
        ) {
          yield* fs.makeDirectory(`${directory}/${folder}`);
          yield* fs.copyFile(`${ownerDirectory}/${folder}/migration.sql`, `${directory}/${folder}/migration.sql`);
          yield* fs.copyFile(`${ownerDirectory}/${folder}/snapshot.json`, `${directory}/${folder}/snapshot.json`);
        });
        yield* Effect.forEach(baselineFolders, copyMigration, { discard: true });
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
        const contactPointId = yield* crypto.randomUUIDv4();
        const obsoleteCaseId = yield* crypto.randomUUIDv4();
        const unaffectedCaseId = yield* crypto.randomUUIDv4();
        const invocationId = yield* crypto.randomUUIDv4();
        const principalId = yield* crypto.randomUUIDv4();
        const validFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z'));
        yield* admin.execute(
          sql`insert into party.parties (party_id,tenant_id,current_type)
            values (${partyId},${tenantId},'ORGANIZATION')`,
          'objects',
        );
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
        yield* admin.execute(
          sql`insert into party.party_fact_assertions
          (tenant_id,party_id,fact_kind,normalized_value,accepted_by_action_invocation_id,
           accepted_by_principal_id,policy_version,provenance_method,provenance_source,valid_from,verification_state)
          values (${tenantId},${partyId},'PARTY_TYPE','ORGANIZATION',${invocationId},${principalId},
            'fixture-acceptance.v1','DOCUMENT','disposable-upgrade-fixture',${validFrom},'UNVERIFIED')`,
          'objects',
        );
        yield* admin.execute(
          sql`insert into party.party_contact_points
          (contact_point_id,tenant_id,party_id,contact_point_type,address_line_1,city,country_code,privacy_classification,
           accepted_by_action_invocation_id,accepted_by_principal_id,policy_version,provenance_method,provenance_source,
           valid_from,verification_state)
          values (${contactPointId},${tenantId},${partyId},'ADDRESS','Fixture 1','Praha','CZ','BUSINESS_SENSITIVE',
            ${invocationId},${principalId},'fixture-acceptance.v1','DECLARED_BY_PARTY','PARTY_DECLARATION',${validFrom},
            'UNVERIFIED')`,
          'objects',
        );
        yield* admin.execute(
          sql`insert into party.party_contact_point_purposes
          (tenant_id,party_id,contact_point_id,purpose_key,accepted_by_action_invocation_id,accepted_by_principal_id,
           policy_version,provenance_method,provenance_source,valid_from,verification_state)
          values (${tenantId},${partyId},${contactPointId},'BILLING',${invocationId},${principalId},
            'fixture-acceptance.v1','DECLARED_BY_PARTY','PARTY_DECLARATION',${validFrom},'UNVERIFIED')`,
          'objects',
        );
        const readAcceptance = () =>
          admin.execute<{ readonly accepted: number }>(
            sql`select count(*)::integer as accepted
              from (select tenant_id, party_id, accepted_by_action_invocation_id, accepted_by_principal_id, policy_version
                    from party.party_fact_assertions
                    union all
                    select tenant_id, party_id, accepted_by_action_invocation_id, accepted_by_principal_id, policy_version
                    from party.party_contact_points
                    union all
                    select tenant_id, party_id, accepted_by_action_invocation_id, accepted_by_principal_id, policy_version
                    from party.party_contact_point_purposes) as assertions
              where tenant_id = ${tenantId} and party_id = ${partyId}
                and accepted_by_action_invocation_id = ${invocationId}
                and accepted_by_principal_id = ${principalId} and policy_version = 'fixture-acceptance.v1'`,
            'objects',
          );
        expect(yield* readAcceptance()).toEqual([{ accepted: 3 }]);
        const legacyCaseId = yield* crypto.randomUUIDv4();
        const legacyNameId = yield* crypto.randomUUIDv4();
        const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
        const provenance = { source: 'disposable-upgrade-fixture', method: 'DOCUMENT' };
        const legacySnapshot = yield* encodeSnapshot({ names: [], provenance, validFrom: validFrom.toISOString() });
        yield* admin.execute(
          sql`insert into party.duplicate_candidate_cases
          (candidate_case_id,tenant_id,candidate_fingerprint,evaluation_fingerprint,candidate_snapshot,
           evaluated_evidence,match_rule_version)
          values (${legacyCaseId},${tenantId},${'e'.repeat(64)},${'f'.repeat(64)},
            ${legacySnapshot}::jsonb,'[]'::jsonb,'fixture-acceptance.v1')`,
          'objects',
        );
        yield* admin.execute(
          sql`insert into party.party_fact_assertions
          (assertion_id,tenant_id,party_id,fact_kind,normalized_value,accepted_by_action_invocation_id,
           accepted_by_principal_id,policy_version,provenance_method,provenance_source,valid_from,verification_state)
          values (${legacyNameId},${tenantId},${partyId},'DISPLAY_NAME','Disposable legacy name',${invocationId},
            ${principalId},'fixture-acceptance.v1','DOCUMENT','disposable-upgrade-fixture',${validFrom},'UNVERIFIED')`,
          'objects',
        );
        yield* copyMigration(structuredNamesFolder);
        // Rehearse the pre-#1321 reset only for the two allowlisted incompatible rows.
        const legacyCases = yield* admin.execute<{ readonly id: string }>(
          sql`delete from party.duplicate_candidate_cases
          where tenant_id = ${tenantId} and candidate_case_id = ${legacyCaseId}
            and candidate_snapshot = ${legacySnapshot}::jsonb returning candidate_case_id as id`,
          'objects',
        );
        const legacyNames = yield* admin.execute<{ readonly id: string }>(
          sql`delete from party.party_fact_assertions
          where tenant_id = ${tenantId} and party_id = ${partyId} and assertion_id = ${legacyNameId}
            and fact_kind = 'DISPLAY_NAME' returning assertion_id as id`,
          'objects',
        );
        expect(legacyCases).toEqual([{ id: legacyCaseId }]);
        expect(legacyNames).toEqual([{ id: legacyNameId }]);
        yield* migrate(admin, options);

        const snapshot = {
          firstName: null,
          lastName: null,
          businessName: null,
          provenance,
          validFrom: validFrom.toISOString(),
        };
        const unaffectedSnapshot = yield* encodeSnapshot(snapshot);
        const obsoleteSnapshot = yield* encodeSnapshot({
          ...snapshot,
          officialIdentifiers: [{ identifierTypeKey: 'ICO', verification: 'VERIFIED' }],
        });
        yield* admin.execute(
          sql`insert into party.duplicate_candidate_cases
          (candidate_case_id,tenant_id,candidate_fingerprint,evaluation_fingerprint,candidate_snapshot,
           evaluated_evidence,match_rule_version)
          values (${obsoleteCaseId},${tenantId},${'a'.repeat(64)},${'b'.repeat(64)},
            ${obsoleteSnapshot}::jsonb,
            '[]'::jsonb,'fixture-acceptance.v1'),
          (${unaffectedCaseId},${tenantId},${'c'.repeat(64)},${'d'.repeat(64)},${unaffectedSnapshot}::jsonb,
            '[]'::jsonb,'fixture-acceptance.v1')`,
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
        yield* Effect.forEach(forwardFolders, copyMigration, { discard: true });
        yield* migrate(admin, options);
        const [after] = yield* readAssertion();
        expect(after).toEqual(before);
        expect(after?.originalInputDigits).toBe('1000004');
        expect(after?.provenanceSource).toBe('disposable-upgrade-fixture');
        expect(after?.acceptedByPrincipalId).toBe(principalId);
        expect(yield* readSecurity()).toEqual(securityBefore);
        expect(yield* readAcceptance()).toEqual([{ accepted: 3 }]);
        // Exact disposable inventory. Preserve the other candidate and the original assertions.
        const discarded = yield* admin.execute<{ readonly id: string }>(
          sql`delete from party.duplicate_candidate_cases
          where tenant_id = ${tenantId} and candidate_case_id = ${obsoleteCaseId}
            and candidate_snapshot->'officialIdentifiers'->0->>'verification' = 'VERIFIED'
          returning candidate_case_id as id`,
          'objects',
        );
        expect(discarded).toEqual([{ id: obsoleteCaseId }]);
        expect(
          yield* admin.execute<{ readonly id: string }>(
            sql`select candidate_case_id as id from party.duplicate_candidate_cases where tenant_id = ${tenantId}`,
            'objects',
          ),
        ).toEqual([{ id: unaffectedCaseId }]);
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
        expect((yield* journal())[0]?.count).toBe(baselineFolders.length + 1 + forwardFolders.length);
        yield* migrate(admin, options);
        expect((yield* journal())[0]?.count).toBe(baselineFolders.length + 1 + forwardFolders.length);
        expect(yield* readAssertion()).toEqual([before]);

        const composition = yield* partyCompositionSnapshot;
        yield* isolated.publishInitialComposition(composition);
        const native = yield* preparePartyReconciliationNative(isolated.connections, 'already-migrated');
        expect(decodeURIComponent(new URL(native.partyConfiguration.connectionString).pathname.slice(1))).toBe(
          isolated.connections.admin.database,
        );
        expect(native.partyConfiguration.expectedRole).toBe(PARTY_REGISTRY_REQUEST_IDENTITY.role);
        const governed = yield* makeGovernedContactFixture({
          adminConnectionString: isolated.connections.admin.connectionString,
          composition,
          gateway: yield* makePartyReconciliationGateway(native, composition),
          partyConfiguration: native.partyConfiguration,
        });
        const added = yield* governed.add({
          address: { addressLine1: 'Upgrade street 7', city: 'Praha', countryCode: 'CZ', postalCode: '11000' },
          purposes: [{ preferred: false, purpose: 'REGISTERED' }],
          type: 'ADDRESS',
        });
        const detail = yield* governed.detail(added.contactPointRef);
        assert.isOk(detail.value?.type === 'ADDRESS');
        expect(detail.value.address.addressLine1).toBe('Upgrade street 7');
        expect(detail.value.purposes).toHaveLength(1);
        expect(detail.value.purposes[0]).toMatchObject({
          current: true,
          provenance: { authoritative: false, source: 'PARTY_DECLARATION' },
          purpose: 'REGISTERED',
        });
        expect(detail.value.purposes[0]).not.toHaveProperty('registryContext');
        const [persisted] = yield* admin
          .select()
          .from(partyContactPoints)
          .where(eq(partyContactPoints.contactPointId, added.contactPointRef.resourceId));
        expect(persisted?.partyId).toBe(governed.partyRef.resourceId);
        expect(yield* readAssertion()).toEqual([before]);
      }),
    120_000,
  );
});
