// @rstest-environment happy-dom
// @rstest-environment-options {"url":"https://party.ontos.test"}
import { fileURLToPath } from 'node:url';

import {
  IsolatedNativeDatabaseError,
  makeIsolatedNativeDatabaseFixture,
} from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { migrate } from 'drizzle-orm/effect-postgres/migrator';
import { ConfigProvider, Crypto, DateTime, Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';

import { preparePartyStructuredNames } from '../../scripts/prepare-party-structured-names.mts';
import { partyRelations } from '../../src/db/schema.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  // The preparation opens its own raw client, so this suite owns its Reactivity.
  Layer.provideMerge(Reactivity.layer),
);

/**
 * The isolated fixture allowlist has no Party assertion-history purpose, so this suite reuses the
 * reviewed Party verification-removal purpose, which carries no behavior of its own beyond the
 * empty-database baseline.
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
const forwardFolders = [
  '20261105154254_young_magik',
  '20261105154619_left_vin_gonzales',
  '20261106083603_aberrant_gauntlet',
  '20261106120000_party-migration-convergence',
  '20261109093237_party-fact-assertion-identities',
] as const;

interface ImageRow extends Readonly<Record<string, string>> {
  readonly id: string;
  readonly image: string;
}

interface ArchivedRow extends Readonly<Record<string, string>> {
  readonly factKind: string;
  readonly id: string;
  readonly image: string;
  readonly isCurrent: string;
  readonly state: string;
  readonly verificationState: string;
}

interface IdentityRow extends Readonly<Record<string, string>> {
  readonly assertionId: string;
  readonly partyId: string;
  readonly tenantId: string;
}

interface ForeignKeyRow extends Readonly<Record<string, string>> {
  readonly conname: string;
  readonly target: string;
}

it.layer(nativeServices, { excludeTestServices: true })('party assertion history preparation', (suite) => {
  suite.effect(
    'retires legacy display-name assertions into a lossless archive without touching evidence or the graph',
    () =>
      Effect.gen(function* partyAssertionHistoryPreparation() {
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
        const client = yield* PgClient.makeClient({
          url: Redacted.make(isolated.connections.admin.connectionString),
        });
        const admin = yield* makeWithDefaults({ relations: partyRelations }).pipe(
          Effect.provideService(PgClient.PgClient, client),
        );
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-party-assertion-history-' });
        const ownerDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));
        const copyMigration = Effect.fn('PartyAssertionHistory.copyMigration')(function* copyMigration(folder: string) {
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
        const otherTenantId = yield* crypto.randomUUIDv4();
        const organizationId = yield* crypto.randomUUIDv4();
        const personId = yield* crypto.randomUUIDv4();
        const unresolvedId = yield* crypto.randomUUIDv4();
        const otherOrganizationId = yield* crypto.randomUUIDv4();
        const partyTypeAssertionId = yield* crypto.randomUUIDv4();
        const organizationNameId = yield* crypto.randomUUIDv4();
        const supersededPersonNameId = yield* crypto.randomUUIDv4();
        const currentPersonNameId = yield* crypto.randomUUIDv4();
        const unresolvedNameId = yield* crypto.randomUUIDv4();
        const preservedTypeAssertionId = yield* crypto.randomUUIDv4();
        const correctionId = yield* crypto.randomUUIDv4();
        const invocationId = yield* crypto.randomUUIDv4();
        const correctionInvocationId = yield* crypto.randomUUIDv4();
        const principalId = yield* crypto.randomUUIDv4();
        const unregisteredId = yield* crypto.randomUUIDv4();
        const registeredStructuredId = yield* crypto.randomUUIDv4();
        const validFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2019-04-05T06:07:08.000Z'));
        const supersededFrom = DateTime.toDateUtc(DateTime.makeUnsafe('2018-01-02T03:04:05.000Z'));

        yield* admin.execute(
          sql`insert into party.parties (party_id,tenant_id,current_type)
            values (${organizationId},${tenantId},'ORGANIZATION'),
              (${personId},${tenantId},'PERSON'),
              (${unresolvedId},${tenantId},'UNRESOLVED'),
              (${otherOrganizationId},${otherTenantId},'ORGANIZATION')`,
          'objects',
        );
        // One legacy assertion per party type: PERSON and UNRESOLVED carry no structured meaning either.
        yield* admin.execute(
          sql`insert into party.party_fact_assertions
          (assertion_id,tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,provenance_method,
           evidence_reference,verification_state,verification_method,verifier_reference,verified_by_principal_id,verified_at,
           accepted_by_action_invocation_id,accepted_by_principal_id,policy_version,evidence_evaluation)
          values
          (${partyTypeAssertionId},${tenantId},${organizationId},'PARTY_TYPE','ORGANIZATION',${validFrom},
            'PARTY_DECLARATION','DECLARED_BY_PARTY',null,'UNVERIFIED',null,null,null,null,${invocationId},${principalId},
            'fixture-acceptance.v1',null),
          (${organizationNameId},${tenantId},${organizationId},'DISPLAY_NAME','Legacy Organization Name',${validFrom},
            'DOCUMENT','ARES_REGISTER','evidence:legacy-organization','VERIFIED','REGISTER_LOOKUP','ares:12345678',
            ${principalId},${validFrom},${invocationId},${principalId},'fixture-acceptance.v1',
            '{"decision":"ACCEPT","policyVersion":"fixture-acceptance.v1"}'::jsonb),
          (${supersededPersonNameId},${tenantId},${personId},'DISPLAY_NAME','Legacy Person Name',${supersededFrom},
            'PARTY_DECLARATION','DECLARED_BY_PARTY',null,'UNVERIFIED',null,null,null,null,${invocationId},${principalId},
            'fixture-acceptance.v1',null),
          (${unresolvedNameId},${tenantId},${unresolvedId},'DISPLAY_NAME','Legacy Unresolved Name',${validFrom},
            'DOCUMENT','IMPORT',null,'UNVERIFIED',null,null,null,null,${invocationId},${principalId},
            'fixture-acceptance.v1',null)`,
          'objects',
        );
        yield* admin.execute(
          sql`update party.party_fact_assertions
            set state = 'SUPERSEDED', is_current = false
            where assertion_id = ${supersededPersonNameId}`,
          'objects',
        );
        yield* admin.execute(
          sql`insert into party.party_fact_assertions
          (assertion_id,tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,provenance_method,
           accepted_by_action_invocation_id,accepted_by_principal_id,policy_version,supersedes_assertion_id)
          values (${currentPersonNameId},${tenantId},${personId},'DISPLAY_NAME','Legacy Person Name',${validFrom},
            'PARTY_DECLARATION','DECLARED_BY_PARTY',${invocationId},${principalId},'fixture-acceptance.v1',
            ${supersededPersonNameId})`,
          'objects',
        );
        // A typed fact the historical schema already supports must remain byte-identical.
        yield* admin.execute(
          sql`insert into party.party_fact_assertions
          (assertion_id,tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,provenance_method,
           accepted_by_action_invocation_id,accepted_by_principal_id,policy_version)
          values (${preservedTypeAssertionId},${tenantId},${organizationId},'PARTY_TYPE','ORGANIZATION',
            ${validFrom},'PARTY_DECLARATION','DECLARED_BY_PARTY',${invocationId},${principalId},'fixture-acceptance.v1')`,
          'objects',
        );
        // A correction that targets a legacy assertion and replaces it with another legacy assertion.
        yield* admin.execute(
          sql`insert into party.party_corrections
          (correction_id,tenant_id,party_id,party_fact_assertion_id,replacement_party_fact_assertion_id,reason,
           evidence_refs,acting_principal_id,action_invocation_id,policy_version)
          values (${correctionId},${tenantId},${personId},${supersededPersonNameId},${currentPersonNameId},
            'Retired display name was reviewed', '["integration:assertion-history"]'::jsonb,${principalId},
            ${correctionInvocationId},'fixture-acceptance.v1')`,
          'objects',
        );

        const readAssertionImages = () =>
          admin.execute<ImageRow>(
            sql`select assertion_id::text as id, to_jsonb(assertion)::text as image
              from party.party_fact_assertions as assertion
              order by assertion_id`,
            'objects',
          );
        const readCorrectionImages = () =>
          admin.execute<ImageRow>(
            sql`select correction_id::text as id, to_jsonb(correction)::text as image
              from party.party_corrections as correction
              order by correction_id`,
            'objects',
          );
        const readArchived = () =>
          admin.execute<ArchivedRow>(
            sql`select assertion_id::text as id,
                  original_assertion::text as image,
                  original_assertion->>'fact_kind' as "factKind",
                  original_assertion->>'state' as state,
                  original_assertion->>'is_current' as "isCurrent",
                  original_assertion->>'verification_state' as "verificationState"
              from party.party_historical_name_assertions
              order by assertion_id`,
            'objects',
          );
        const readIdentities = () =>
          admin.execute<IdentityRow>(
            sql`select assertion_id::text as "assertionId", tenant_id::text as "tenantId", party_id::text as "partyId"
              from party.party_fact_assertion_identities
              order by assertion_id`,
            'objects',
          );

        const before = yield* readAssertionImages();
        const beforeById = new Map(before.map((row) => [row.id, row.image]));
        const correctionsBefore = yield* readCorrectionImages();
        const legacyNameIds = [organizationNameId, supersededPersonNameId, currentPersonNameId, unresolvedNameId];
        for (const assertionId of legacyNameIds) {
          expect(beforeById.has(assertionId), assertionId).toBe(true);
        }
        expect(beforeById.get(supersededPersonNameId)).toContain('"state": "SUPERSEDED"');
        expect(beforeById.get(supersededPersonNameId)).toContain('"is_current": false');
        expect(beforeById.get(organizationNameId)).toContain('"verification_state": "VERIFIED"');

        // Preparation and native convergence share one client and transaction, as they do at startup.
        // Deferred archive checks must drain before the appended migration reinstalls table triggers.
        yield* copyMigration(structuredNamesFolder);
        yield* Effect.forEach(forwardFolders, copyMigration, { discard: true });
        const preparation = yield* client.withTransaction(
          Effect.gen(function* convergeHistoricalAssertions() {
            const state = yield* preparePartyStructuredNames(client);
            const assertions = yield* readAssertionImages();
            yield* migrate(admin, options);
            return { assertions, state };
          }),
        );
        expect(preparation.state).toBe('prepared');

        const after = yield* readAssertionImages();
        const afterById = new Map(preparation.assertions.map((row) => [row.id, row.image]));
        expect(afterById.has(organizationNameId)).toBe(false);
        expect(afterById.has(supersededPersonNameId)).toBe(false);
        expect(afterById.has(currentPersonNameId)).toBe(false);
        expect(afterById.has(unresolvedNameId)).toBe(false);
        // Preparation leaves every surviving assertion byte-identical before native schema evolution.
        for (const [id, image] of afterById) {
          expect(image, id).toBe(beforeById.get(id));
        }
        expect(afterById.get(preservedTypeAssertionId)).toContain('"fact_kind": "PARTY_TYPE"');

        const archived = yield* readArchived();
        expect(archived.map((row) => row.id).toSorted()).toEqual([...legacyNameIds].toSorted());
        for (const row of archived) {
          // The archive is the exact original current-store row, member for member.
          expect(row.image, row.id).toBe(beforeById.get(row.id));
          expect(row.factKind, row.id).toBe('DISPLAY_NAME');
          expect(row.image, row.id).toContain('"accepted_by_principal_id"');
          expect(row.image, row.id).toContain('"recorded_at"');
          expect(row.image, row.id).toContain('"provenance_source"');
        }
        const archivedById = new Map(archived.map((row) => [row.id, row]));
        expect(archivedById.get(supersededPersonNameId)?.state).toBe('SUPERSEDED');
        expect(archivedById.get(supersededPersonNameId)?.isCurrent).toBe('false');
        expect(archivedById.get(currentPersonNameId)?.state).toBe('ACTIVE');
        expect(archivedById.get(currentPersonNameId)?.isCurrent).toBe('true');
        expect(archivedById.get(organizationNameId)?.verificationState).toBe('VERIFIED');

        const identities = yield* readIdentities();
        expect(identities.map((row) => row.assertionId).toSorted()).toEqual(before.map((row) => row.id).toSorted());
        for (const row of identities) {
          expect(row.tenantId, row.assertionId).toBe(tenantId);
        }

        // 2. No correction row moved, and every fact reference now resolves against the registry.
        expect(yield* readCorrectionImages()).toEqual(correctionsBefore);
        const foreignKeys = yield* admin.execute<ForeignKeyRow>(
          sql`select constraint_record.conname as conname, referenced.relname as target
            from pg_catalog.pg_constraint as constraint_record
            inner join pg_catalog.pg_class as relation on relation.oid = constraint_record.conrelid
            inner join pg_catalog.pg_class as referenced on referenced.oid = constraint_record.confrelid
            where constraint_record.contype = 'f'
              and constraint_record.conname in (
                'party_fact_assertions_tenant_supersedes_fk',
                'party_fact_assertions_tenant_retracts_fk',
                'party_corrections_tenant_fact_fk',
                'party_corrections_tenant_replacement_fact_fk')
            order by conname`,
          'objects',
        );
        expect(foreignKeys.map((row) => row.conname)).toEqual([
          'party_corrections_tenant_fact_fk',
          'party_corrections_tenant_replacement_fact_fk',
          'party_fact_assertions_tenant_retracts_fk',
          'party_fact_assertions_tenant_supersedes_fk',
        ]);
        for (const row of foreignKeys) {
          expect(row.target, row.conname).toBe('party_fact_assertion_identities');
        }

        // 3. A second preparation is a committed no-op over every relation it owns.
        expect(yield* preparePartyStructuredNames(client)).toBe('unchanged');
        expect(yield* readAssertionImages()).toEqual(after);
        expect(yield* readArchived()).toEqual(archived);
        expect(yield* readIdentities()).toEqual(identities);

        // 4. The archive is immutable and identities cannot be reused.
        const archiveUpdate = yield* Effect.exit(
          admin.execute(
            sql`update party.party_historical_name_assertions set tenant_id = tenant_id
              where assertion_id = ${organizationNameId}`,
            'objects',
          ),
        );
        expect(Exit.isFailure(archiveUpdate)).toBe(true);
        const archiveDelete = yield* Effect.exit(
          admin.execute(
            sql`delete from party.party_historical_name_assertions where assertion_id = ${organizationNameId}`,
            'objects',
          ),
        );
        expect(Exit.isFailure(archiveDelete)).toBe(true);
        const reusedIdentity = yield* Effect.exit(
          admin.execute(
            sql`insert into party.party_fact_assertions
              (assertion_id,tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,
               provenance_method,accepted_by_action_invocation_id,accepted_by_principal_id,policy_version)
              values (${organizationNameId},${tenantId},${organizationId},'BUSINESS_NAME','Reused legacy name',
                ${validFrom},'DOCUMENT','IMPORT',${invocationId},${principalId},'fixture-acceptance.v1')`,
            'objects',
          ),
        );
        expect(Exit.isFailure(reusedIdentity)).toBe(true);
        const reusedAcrossTenants = yield* Effect.exit(
          admin.execute(
            sql`insert into party.party_fact_assertions
              (assertion_id,tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,
               provenance_method,accepted_by_action_invocation_id,accepted_by_principal_id,policy_version)
              values (${preservedTypeAssertionId},${otherTenantId},${otherOrganizationId},'PARTY_TYPE','ORGANIZATION',
                ${validFrom},'DOCUMENT','IMPORT',${invocationId},${principalId},'fixture-acceptance.v1')`,
            'objects',
          ),
        );
        expect(Exit.isFailure(reusedAcrossTenants)).toBe(true);
        const unregisteredArchive = yield* Effect.exit(
          admin.execute(
            sql`insert into party.party_historical_name_assertions
              (assertion_id,tenant_id,party_id,original_assertion)
              values (${unregisteredId},${tenantId},${organizationId},'{}'::jsonb)`,
            'objects',
          ),
        );
        expect(Exit.isFailure(unregisteredArchive)).toBe(true);
        // Archiving a still-current assertion is refused when the transaction ends.
        const liveCollision = yield* Effect.exit(
          admin.execute(
            sql`insert into party.party_historical_name_assertions
              (assertion_id,tenant_id,party_id,original_assertion)
              select assertion.assertion_id, assertion.tenant_id, assertion.party_id, to_jsonb(assertion)
              from party.party_fact_assertions as assertion
              where assertion.assertion_id = ${preservedTypeAssertionId}`,
            'objects',
          ),
        );
        expect(Exit.isFailure(liveCollision)).toBe(true);
        expect(yield* readArchived()).toEqual(archived);

        // The already-converged native history is idempotent, and the archive keeps retired columns.
        yield* migrate(admin, options);
        const [journal] = yield* admin.execute<{ readonly count: number }>(
          sql`select count(*)::integer as count from drizzle.__drizzle_migrations_party`,
          'objects',
        );
        expect(journal?.count).toBe(baselineFolders.length + 1 + forwardFolders.length);
        expect(yield* readArchived()).toEqual(archived);
        expect(yield* readIdentities()).toEqual(identities);
        const [removedColumns] = yield* admin.execute<{ readonly columns: number }>(
          sql`select count(*)::integer as columns from information_schema.columns
            where table_schema = 'party' and table_name = 'party_fact_assertions'
              and column_name in ('verification_state','verification_method','verifier_reference',
                'verified_by_principal_id','verified_at')`,
          'objects',
        );
        expect(removedColumns?.columns).toBe(0);
        // The retired row still carries the verification evidence the current store dropped.
        expect(archivedById.get(organizationNameId)?.verificationState).toBe('VERIFIED');
        expect((yield* readArchived()).find((row) => row.id === organizationNameId)?.image).toContain(
          '"verification_method": "REGISTER_LOOKUP"',
        );
        const narrowedKind = yield* Effect.exit(
          admin.execute(
            sql`insert into party.party_fact_assertions
              (tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,provenance_method,
               accepted_by_action_invocation_id,accepted_by_principal_id,policy_version)
              values (${tenantId},${organizationId},'DISPLAY_NAME','Legacy Again',${validFrom},'DOCUMENT','IMPORT',
                ${invocationId},${principalId},'fixture-acceptance.v1')`,
            'objects',
          ),
        );
        expect(Exit.isFailure(narrowedKind)).toBe(true);
        // A structured assertion still registers through the invoker trigger after convergence.
        yield* admin.execute(
          sql`insert into party.party_fact_assertions
            (assertion_id,tenant_id,party_id,fact_kind,normalized_value,valid_from,provenance_source,
             provenance_method,accepted_by_action_invocation_id,accepted_by_principal_id,policy_version)
            values (${registeredStructuredId},${tenantId},${organizationId},'BUSINESS_NAME','Converged s.r.o.',
              ${validFrom},'PARTY_DECLARATION','DECLARED_BY_PARTY',${invocationId},${principalId},
              'fixture-acceptance.v1')`,
          'objects',
        );
        expect((yield* readIdentities()).some((row) => row.assertionId === registeredStructuredId)).toBe(true);
      }),
    180_000,
  );
});
