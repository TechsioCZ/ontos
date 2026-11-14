import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { makeApplicationCompositionSnapshotFixture } from '@app/core-runtime/testing/module-contract';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { parties, partyOfficialIdentifiers, partyRelations } from '../../src/db/schema.ts';
import {
  OrganizationMigrationFixtureError,
  seedOrganizationMigrationFixture,
} from '../support/organization-migration.fixture.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
);

it.layer(nativeServices, { excludeTestServices: true })((suite) => {
  suite.effect(
    'seeds only synthetic native organization facts and refuses forged, foreign or mismatched ownership',
    () =>
      Effect.gen(function* ownedOrganizationMigration() {
        const compositionSnapshot = yield* makeApplicationCompositionSnapshotFixture(['party-registry']);
        const ownedDatabase = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-registered-workload-gateway',
        });
        const wrongPurpose = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot,
          mode: 'schema-only',
          purpose: 'implementation-1197-profile-ico',
        });
        // Public Core test setup owns its human identity. The Party seed itself grants no authority.
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            actionKeys: [],
            adminConnectionString: Redacted.make(ownedDatabase.connections.admin.connectionString),
            authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: compositionSnapshot.composition.revision,
            runtimeConnectionString: Redacted.make(ownedDatabase.connections.runtime.connectionString),
          }),
          (value) => value.close().pipe(Effect.orDie),
        );
        const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          ...fixture.manager,
          legalEntityId: fixture.legalEntityId,
        });
        const input = {
          connections: ownedDatabase.connections,
          ownedDatabase,
          principal,
          purpose: 'implementation-1096-registered-workload-gateway' as const,
          originalInput: { kind: 'KNOWN' as const, digits: '19' as const },
        };
        const adminClient = yield* PgClient.make({
          url: Redacted.make(ownedDatabase.connections.admin.connectionString),
        });
        const database = yield* makeWithDefaults({ relations: partyRelations }).pipe(
          Effect.provideService(PgClient.PgClient, adminClient),
        );
        const crypto = yield* Crypto.Crypto;
        const existingPartyId = yield* crypto.randomUUIDv4();
        yield* database.insert(parties).values({
          partyId: existingPartyId,
          tenantId: fixture.tenantId,
          currentType: 'PERSON',
          revision: 7,
        });
        const known = yield* seedOrganizationMigrationFixture(input);
        const unknown = yield* seedOrganizationMigrationFixture({ ...input, originalInput: { kind: 'UNKNOWN' } });
        expect(known.partyRef.resourceId).not.toBe(unknown.partyRef.resourceId);
        expect(known.partyRevision).toBe(1);
        expect(known.counterpartyRevision).toMatch(/^[a-f0-9]{64}$/u);
        expect(known.currentCustomerRoleRevision).toMatch(/^[a-f0-9]{64}$/u);
        expect(known.legacyAssertionRevision).toMatch(/^[a-f0-9]{64}$/u);
        const identifiers = yield* database
          .select({
            original: partyOfficialIdentifiers.originalInputDigits,
            normalized: partyOfficialIdentifiers.normalizedValue,
            source: partyOfficialIdentifiers.provenanceSource,
            method: partyOfficialIdentifiers.provenanceMethod,
          })
          .from(partyOfficialIdentifiers)
          .where(eq(partyOfficialIdentifiers.tenantId, fixture.tenantId));
        expect(identifiers).toHaveLength(2);
        expect(identifiers.map(({ original }) => original).toSorted()).toEqual(['19', null]);
        expect(
          identifiers.every(
            ({ normalized, source, method }) =>
              normalized === '00000019' && source === 'INTERNAL_OWNER_SETUP' && method === 'MIGRATION_REVIEW',
          ),
        ).toBe(true);
        const refused = [
          { ...input, ownedDatabase: { ...ownedDatabase } },
          { ...input, ownedDatabase: wrongPurpose, connections: wrongPurpose.connections },
          { ...input, connections: wrongPurpose.connections },
          { ...input, principal: { ...principal, tenantId: yield* crypto.randomUUIDv4() } },
          { ...input, principal: { ...principal, legalEntityId: yield* crypto.randomUUIDv4() } },
          { ...input, principal: { ...principal, authBindingId: yield* crypto.randomUUIDv4() } },
        ];
        for (const candidate of refused) {
          const error = yield* seedOrganizationMigrationFixture(candidate).pipe(Effect.flip);
          expect(Schema.is(OrganizationMigrationFixtureError)(error)).toBe(true);
        }
        const existing = yield* database
          .select({ type: parties.currentType, revision: parties.revision })
          .from(parties)
          .where(and(eq(parties.tenantId, fixture.tenantId), eq(parties.partyId, existingPartyId)));
        expect(existing).toEqual([{ type: 'PERSON', revision: 7 }]);
        const all = yield* database
          .select({ partyId: parties.partyId })
          .from(parties)
          .where(eq(parties.tenantId, fixture.tenantId));
        expect(all).toHaveLength(3);
      }),
    180_000,
  );
});
