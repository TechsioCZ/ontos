import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  counterparties,
  parties,
  partyOfficialIdentifiers,
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
        // Roll back the whole fixture: the permanent fence deliberately has no delete/unfence operation.
        const outcome = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* fixtureTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
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
            }).pipe(
              Effect.provideService(PartyLegacyIcoPrivacy, { authorize: () => Effect.succeed('ALLOWED' as const) }),
            ),
          )
          .pipe(Effect.result);
        expect(Result.match(outcome, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_fixture_rollback',
        );
      }),
  );
});
