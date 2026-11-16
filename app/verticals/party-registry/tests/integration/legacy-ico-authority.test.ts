import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  counterparties,
  parties,
  partyOfficialIdentifiers,
  partyIcoCorrelationEpochs,
  partyRelations,
  partyLegacyIcoAuthorityFences,
} from '../../src/db/schema.ts';
import {
  findCounterpartyMigrationCorrelation,
  loadLegacyIcoInventory,
  legacyIcoAuthorityService,
  PartyLegacyIcoPrivacy,
} from '../../src/services/legacy-ico-authority.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
  hasPostgreSqlCode,
} from '../support/database-boundary.ts';

const tenantId = 'df100000-0000-4000-8000-000000000001';
const legalEntityId = 'df500000-0000-4000-8000-000000000001';
const principalId = 'df200000-0000-4000-8000-000000000001';
const partyId = 'df300000-0000-4000-8000-000000000001';
const invocationId = 'df400000-0000-4000-8000-000000000001';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native Party scope fences an exact complete snapshot, recovers the same proof, and permanently rejects ICO writes while DIČ remains writable',
    () =>
      Effect.gen(function* authorityBoundary() {
        const clients = yield* openPartyBoundaryClients();
        const [privateTable] = yield* clients.runtime<{ canSelect: boolean }>`
          select has_table_privilege(current_user,'party.party_ico_correlation_epochs','select') as "canSelect"
        `;
        expect(privateTable?.canSelect).toBe(false);
        const { runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const scope = {
          ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            tenantId,
            legalEntityId,
            principalId,
            authMethod: 'session',
            authBindingId: principalId,
            authContextRef: 'session:internal-ico-migration-fixture',
          })),
          correlationId: 'internal-ico-migration-fixture',
        };
        const allowed = { authorize: () => Effect.succeed('ALLOWED' as const) };
        const proofGrant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const challenge = invocationId;
        const lockKey = `ontos.owner-fact.party-ico.correlation:${tenantId}`;
        const nonce = `ontos.owner-fact.party-ico.challenge:${tenantId}:${legalEntityId}:${challenge}`;
        yield* clients.admin.withTransaction(
          Effect.gen(function* heldCommitFence() {
            yield* clients.admin`select pg_advisory_xact_lock_shared(hashtextextended(${lockKey},0)),
            pg_advisory_xact_lock_shared(hashtextextended(${nonce},0))`;
            const guarded = yield* runtime.transaction((transaction) =>
              establishPartyGatewayScope(transaction, proofGrant).pipe(
                Effect.andThen(loadLegacyIcoInventory(transaction, scope, undefined, true, [], challenge)),
                Effect.provideService(PartyLegacyIcoPrivacy, allowed),
              ),
            );
            expect(guarded.commitFenceHeld).toBe(true);
          }),
        );
        // Roll back the whole fixture: the permanent fence deliberately has no delete/unfence operation.
        const outcome = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* fixtureTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const unheld = yield* loadLegacyIcoInventory(transaction, scope, undefined, true, [], challenge).pipe(
                Effect.result,
              );
              expect(Result.isFailure(unheld)).toBe(true);
              yield* transaction.insert(parties).values({ tenantId, partyId, currentType: 'ORGANIZATION' });
              yield* transaction.insert(counterparties).values({
                tenantId,
                partyId,
                legalEntityId,
                counterpartyId: invocationId,
                creationReason: 'internal migration fixture',
                evidenceRefs: ['internal-fixture'],
                sourceRecordRefs: [],
                provenanceSource: 'internal-fixture',
                provenanceMethod: 'MANUAL',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              });
              const counterpartyRef = {
                moduleId: 'party.registry' as const,
                resourceType: 'party.registry.counterparty' as const,
                resourceId: invocationId,
                tenantId,
              };
              const correlation = yield* findCounterpartyMigrationCorrelation(transaction, scope, counterpartyRef);
              expect(correlation?.partyRef.resourceId).toBe(partyId);
              expect(correlation?.archived).toBe(false);
              expect(
                yield* findCounterpartyMigrationCorrelation(transaction, scope, {
                  ...counterpartyRef,
                  resourceId: principalId,
                }),
              ).toBeUndefined();
              const identifier = {
                tenantId,
                partyId,
                namespace: 'CZ:ICO',
                identifierTypeKey: 'ICO',
                normalizedValue: '01000004',
                validFrom: '2020-01-01T00:00:00.000Z',
                provenanceSource: 'internal-migration-fixture',
                provenanceMethod: 'LEGACY',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              };
              yield* transaction
                .insert(partyOfficialIdentifiers)
                .values({ ...identifier, validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(identifier.validFrom)) });
              const inventory = yield* loadLegacyIcoInventory(transaction, scope);
              expect(inventory.assertions).toHaveLength(1);
              expect(inventory.assertions[0]?.originalInput).toEqual({ kind: 'UNKNOWN' });
              const correlationWithProof = yield* findCounterpartyMigrationCorrelation(
                transaction,
                scope,
                counterpartyRef,
                true,
              );
              const witness = correlationWithProof?.correlationWitness;
              if (witness === undefined) {
                return yield* Effect.die('Expected the exact Party correlation witness');
              }
              expect(witness).toMatchObject({ counterpartyId: invocationId, legalEntityId });
              const provedInventory = yield* loadLegacyIcoInventory(transaction, scope, undefined, true, [witness]);
              expect(provedInventory.correlationCoverage?.foreignMatchCounts).toEqual([1]);
              expect(provedInventory.assertions).toEqual(inventory.assertions);
              const forged = yield* loadLegacyIcoInventory(transaction, scope, undefined, true, [
                { ...witness, legalEntityId: principalId },
              ]);
              expect(forged.correlationCoverage?.foreignMatchCounts).toBeUndefined();
              const observedBeforeChange = yield* findCounterpartyMigrationCorrelation(
                transaction,
                scope,
                counterpartyRef,
                true,
              ).pipe(
                Effect.provideService(PartyLegacyIcoPrivacy, {
                  authorize: () =>
                    transaction
                      .update(counterparties)
                      .set({ archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2025-01-01T00:00:00.000Z')) })
                      .where(eq(counterparties.counterpartyId, invocationId))
                      .pipe(Effect.orDie, Effect.as('ALLOWED' as const)),
                }),
              );
              expect(observedBeforeChange).toMatchObject({ archived: false, correlationWitness: witness });
              const changed = yield* loadLegacyIcoInventory(transaction, scope, undefined, true, [witness]);
              expect(changed.snapshotVersion).toBe(provedInventory.snapshotVersion);
              expect(changed.correlationCoverage?.epoch).not.toBe(provedInventory.correlationCoverage?.epoch);
              expect(changed.correlationCoverage?.foreignMatchCounts).toBeUndefined();
              const service = yield* legacyIcoAuthorityService(transaction, scope);
              const stale = yield* service
                .fence({ expectedSnapshotVersion: '0'.repeat(64), migrationPlanRef: 'internal-plan' }, invocationId)
                .pipe(Effect.result);
              expect(Result.isFailure(stale)).toBe(true);
              yield* transaction.insert(partyOfficialIdentifiers).values({
                ...identifier,
                originalInputDigits: '1000004',
                state: 'ENDED',
                isCurrent: false,
                validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')),
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(identifier.validFrom)),
              });
              expect(
                Result.isFailure(
                  yield* service
                    .fence(
                      { expectedSnapshotVersion: inventory.snapshotVersion, migrationPlanRef: 'internal-plan' },
                      invocationId,
                    )
                    .pipe(Effect.result),
                ),
              ).toBe(true);
              const currentInventory = yield* loadLegacyIcoInventory(transaction, scope);
              expect(currentInventory.assertions).toHaveLength(2);
              const payload = {
                expectedSnapshotVersion: currentInventory.snapshotVersion,
                migrationPlanRef: 'internal-plan',
              };
              const proof = yield* service.fence(payload, invocationId);
              expect(yield* service.fence(payload, invocationId)).toEqual(proof);
              expect(
                Result.isFailure(
                  yield* service
                    .fence({ ...payload, migrationPlanRef: 'different-plan' }, invocationId)
                    .pipe(Effect.result),
                ),
              ).toBe(true);
              const fenced = yield* loadLegacyIcoInventory(transaction, scope);
              expect(fenced.authority).toEqual({ kind: 'COMMERCE_FENCED', proof });
              // A savepoint preserves the enclosing proof transaction after each expected PostgreSQL rejection.
              const rejectedIco = yield* transaction
                .transaction((savepoint) =>
                  savepoint.insert(partyOfficialIdentifiers).values({
                    ...identifier,
                    validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(identifier.validFrom)),
                  }),
                )
                .pipe(Effect.result);
              expect(Result.isFailure(rejectedIco)).toBe(true);
              if (Result.isFailure(rejectedIco)) {
                expect(hasPostgreSqlCode('23514')(rejectedIco.failure)).toBe(true);
              }
              yield* transaction.insert(partyOfficialIdentifiers).values({
                ...identifier,
                namespace: 'CZ:DIC',
                identifierTypeKey: 'CZ_DIC',
                normalizedValue: 'CZ01000004',
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(identifier.validFrom)),
              });
              expect(
                Result.isFailure(
                  yield* transaction
                    .transaction((savepoint) => savepoint.delete(partyLegacyIcoAuthorityFences))
                    .pipe(Effect.result),
                ),
              ).toBe(true);
              return yield* Effect.fail('internal_fixture_rollback' as const);
            }).pipe(Effect.provideService(PartyLegacyIcoPrivacy, allowed)),
          )
          .pipe(Effect.result);
        expect(Result.match(outcome, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_fixture_rollback',
        );
      }),
  );

  suite.effect('issues exact native home proofs and verifies retained foreign proof without disclosing its Party', () =>
    Effect.gen(function* twoHomeCorrelation() {
      const crypto = yield* Crypto.Crypto;
      const tenant = yield* crypto.randomUUIDv4();
      const homeA = yield* crypto.randomUUIDv4();
      const homeB = yield* crypto.randomUUIDv4();
      const party = yield* crypto.randomUUIDv4();
      const counterpartyA = yield* crypto.randomUUIDv4();
      const counterpartyB = yield* crypto.randomUUIDv4();
      const clients = yield* openPartyBoundaryClients();
      const { admin, runtime } = yield* openBoundaryDatabases(
        (client) => makeTestDatabaseFromClient(client, partyRelations),
        clients,
      );
      const grantA = yield* registerPartyGatewayScope(clients, { tenantId: tenant, legalEntityId: homeA });
      const grantB = yield* registerPartyGatewayScope(clients, { tenantId: tenant, legalEntityId: homeB });
      yield* Effect.addFinalizer(() =>
        admin
          .transaction((transaction) =>
            Effect.gen(function* removeTwoHomeFacts() {
              yield* transaction.delete(partyOfficialIdentifiers).where(eq(partyOfficialIdentifiers.tenantId, tenant));
              yield* transaction.delete(counterparties).where(eq(counterparties.tenantId, tenant));
              yield* transaction.delete(parties).where(eq(parties.tenantId, tenant));
              yield* transaction
                .delete(partyIcoCorrelationEpochs)
                .where(eq(partyIcoCorrelationEpochs.tenantId, tenant));
            }),
          )
          .pipe(Effect.orDie),
      );
      yield* admin.transaction((transaction) =>
        Effect.gen(function* seedTwoHomeFacts() {
          yield* transaction.insert(parties).values({ tenantId: tenant, partyId: party, currentType: 'ORGANIZATION' });
          yield* transaction.insert(counterparties).values(
            [
              { counterpartyId: counterpartyA, legalEntityId: homeA },
              { counterpartyId: counterpartyB, legalEntityId: homeB },
            ].map((home) => ({
              ...home,
              tenantId: tenant,
              partyId: party,
              creationReason: 'internal two-home correlation fixture',
              evidenceRefs: ['fixture'],
              sourceRecordRefs: [],
              provenanceSource: 'fixture',
              provenanceMethod: 'MANUAL',
              acceptedByActionInvocationId: invocationId,
              acceptedByPrincipalId: principalId,
              policyVersion: 'fixture',
            })),
          );
          yield* transaction.insert(partyOfficialIdentifiers).values({
            tenantId: tenant,
            partyId: party,
            namespace: 'CZ:ICO',
            identifierTypeKey: 'ICO',
            normalizedValue: '01000004',
            validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00.000Z')),
            provenanceSource: 'fixture',
            provenanceMethod: 'LEGACY',
            acceptedByActionInvocationId: invocationId,
            acceptedByPrincipalId: principalId,
            policyVersion: 'fixture',
          });
        }),
      );
      const scopeFor = (home: string) =>
        Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          tenantId: tenant,
          legalEntityId: home,
          principalId,
          authMethod: 'session',
          authBindingId: principalId,
          authContextRef: 'session:internal-two-home-ico-fixture',
        }).pipe(Effect.map((scope) => ({ ...scope, correlationId: 'internal-two-home-ico-fixture' })));
      const ref = (resourceId: string) => ({
        moduleId: 'party.registry' as const,
        resourceType: 'party.registry.counterparty' as const,
        resourceId,
        tenantId: tenant,
      });
      const allowed = { authorize: () => Effect.succeed('ALLOWED' as const) };
      const scopeB = yield* scopeFor(homeB);
      const observedB = yield* runtime.transaction((transaction) =>
        establishPartyGatewayScope(transaction, grantB).pipe(
          Effect.andThen(findCounterpartyMigrationCorrelation(transaction, scopeB, ref(counterpartyB), true)),
          Effect.provideService(PartyLegacyIcoPrivacy, allowed),
        ),
      );
      const witnessB = yield* Effect.fromNullishOr(observedB?.correlationWitness).pipe(Effect.orDie);
      const scopeA = yield* scopeFor(homeA);
      yield* runtime.transaction((transaction) =>
        Effect.gen(function* observeAtHomeA() {
          yield* establishPartyGatewayScope(transaction, grantA);
          const [foreign] = yield* transaction
            .select({ witness: sql<unknown>`party.issue_ico_correlation_witness(${counterpartyB}::uuid)` })
            .from(sql`(values (1)) as party_foreign_witness_probe(value)`);
          expect(foreign?.witness).toBeNull();
          const observedA = yield* findCounterpartyMigrationCorrelation(transaction, scopeA, ref(counterpartyA), true);
          expect(observedA?.correlationWitness).toMatchObject({ counterpartyId: counterpartyA, legalEntityId: homeA });
          expect(witnessB).toMatchObject({ counterpartyId: counterpartyB, legalEntityId: homeB });
          const inventory = yield* loadLegacyIcoInventory(transaction, scopeA, undefined, true, [witnessB]);
          expect(inventory.correlationCoverage).toEqual({ epoch: witnessB.epoch, foreignMatchCounts: [1] });
        }).pipe(Effect.provideService(PartyLegacyIcoPrivacy, allowed)),
      );
    }),
  );
});
