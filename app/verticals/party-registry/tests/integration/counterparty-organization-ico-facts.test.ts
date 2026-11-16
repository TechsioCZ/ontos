import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Schema, Result } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  counterparties,
  counterpartyRolePeriods,
  parties,
  partyFactAssertions,
  partyRelations,
} from '../../src/db/schema.ts';
import { readCounterpartyOrganizationIcoFacts } from '../../src/services/counterparty-organization-ico-facts.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'dfa10000-0000-4000-8000-000000000001';
const principalId = 'dfa20000-0000-4000-8000-000000000001';
const legalEntityId = 'dfa30000-0000-4000-8000-000000000001';
const invocationId = 'dfa40000-0000-4000-8000-000000000001';
const partyId = 'dfa50000-0000-4000-8000-000000000001';
const counterpartyId = 'dfa60000-0000-4000-8000-000000000001';
const rolePeriodId = 'dfa70000-0000-4000-8000-000000000001';
const instant = '2020-01-01T00:00:00.000Z';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native exact Counterparty company ICO facts require canonical ORG and effective CUSTOMER, expose only opaque versions and reject wrong scope or lifecycle',
    () =>
      Effect.gen(function* counterpartyIcoFactsTest() {
        const clients = yield* openPartyBoundaryClients();
        const { runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          tenantId,
          legalEntityId,
          principalId,
          authMethod: 'session',
          authBindingId: principalId,
          authContextRef: 'session:internal-counterparty-ico-facts-fixture',
        });
        const scope = { ...principal, correlationId: 'internal-counterparty-ico-facts-fixture' };
        const done = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* counterpartyIcoFactsTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              yield* transaction.execute(sql`set local timezone = 'UTC'`, 'objects');
              yield* transaction
                .insert(parties)
                .values({ tenantId, partyId, currentType: 'ORGANIZATION', revision: 7 });
              const assertion = {
                tenantId,
                partyId,
                factKind: 'PARTY_TYPE',
                normalizedValue: 'ORGANIZATION',
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                provenanceSource: 'private source text',
                provenanceMethod: 'private method text',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'internal-fixture',
              };
              yield* transaction.insert(partyFactAssertions).values(assertion);
              yield* transaction.insert(counterparties).values({
                tenantId,
                legalEntityId,
                partyId,
                counterpartyId,
                creationReason: 'private counterparty reason',
                evidenceRefs: ['private evidence text'],
                sourceRecordRefs: ['private source locator'],
                provenanceSource: 'private source text',
                provenanceMethod: 'private method text',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'internal-fixture',
              });
              const request = {
                counterpartyRef: {
                  moduleId: 'party.registry' as const,
                  resourceType: 'party.registry.counterparty' as const,
                  resourceId: counterpartyId,
                  tenantId,
                },
              };
              const denied = { outcome: 'NOT_CURRENT_ORGANIZATION_CUSTOMER' };
              expect(yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request)).toEqual(denied);
              yield* transaction.insert(counterpartyRolePeriods).values({
                tenantId,
                legalEntityId,
                counterpartyId,
                rolePeriodId,
                roleType: 'CUSTOMER',
                isCurrent: true,
                addReason: 'private role reason',
                addEvidenceRefs: ['private role evidence'],
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                provenanceSource: 'private source text',
                provenanceMethod: 'private method text',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'internal-fixture',
              });
              const proof = yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request);
              assert.isOk(proof.outcome === 'CURRENT_ORGANIZATION_CUSTOMER');
              expect(proof.partyRef.resourceId).toBe(partyId);
              expect(proof.partyRevision).toBe(7);
              expect(proof.legalEntityRef.resourceId).toBe(legalEntityId);
              expect(proof.currentCustomerRoleRef.resourceId).toBe(rolePeriodId);
              expect(proof.counterpartyRevision).toHaveLength(64);
              expect(proof.currentCustomerRoleRevision).toHaveLength(64);
              expect(proof).not.toHaveProperty('creationReason');
              expect(proof).not.toHaveProperty('provenanceSource');
              expect(proof).not.toHaveProperty('acceptedByPrincipalId');
              yield* transaction.execute(sql`set local timezone = 'Europe/Prague'`, 'objects');
              expect(yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request)).toEqual(proof);
              yield* transaction
                .update(counterparties)
                .set({ creationReason: 'changed private reason' })
                .where(and(eq(counterparties.tenantId, tenantId), eq(counterparties.counterpartyId, counterpartyId)));
              const revised = yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request);
              assert.isOk(revised.outcome === 'CURRENT_ORGANIZATION_CUSTOMER');
              expect(revised.counterpartyRevision).not.toBe(proof.counterpartyRevision);
              // The owner derives effective membership from state and valid time, not its recorded-at projection flag.
              yield* transaction
                .update(counterpartyRolePeriods)
                .set({ isCurrent: false })
                .where(
                  and(
                    eq(counterpartyRolePeriods.tenantId, tenantId),
                    eq(counterpartyRolePeriods.rolePeriodId, rolePeriodId),
                  ),
                );
              expect(yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request)).toMatchObject({
                outcome: 'CURRENT_ORGANIZATION_CUSTOMER',
                currentCustomerRoleRef: proof.currentCustomerRoleRef,
              });
              const foreign = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
                ...principal,
                legalEntityId: 'dfa30000-0000-4000-8000-000000000002',
              });
              expect(
                yield* readCounterpartyOrganizationIcoFacts(
                  transaction,
                  { ...foreign, correlationId: scope.correlationId },
                  request,
                ),
              ).toEqual(denied);
              expect(
                yield* readCounterpartyOrganizationIcoFacts(transaction, scope, {
                  counterpartyRef: { ...request.counterpartyRef, tenantId: 'dfa10000-0000-4000-8000-000000000002' },
                }),
              ).toEqual(denied);
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'PERSON' })
                .where(and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, partyId)));
              expect(yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request)).toEqual(denied);
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'ORGANIZATION' })
                .where(and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, partyId)));
              yield* transaction
                .update(counterparties)
                .set({ archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-01-01T00:00:00Z')) })
                .where(and(eq(counterparties.tenantId, tenantId), eq(counterparties.counterpartyId, counterpartyId)));
              expect(yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request)).toEqual(denied);
              yield* transaction
                .update(counterparties)
                .set({ archivedAt: null })
                .where(and(eq(counterparties.tenantId, tenantId), eq(counterparties.counterpartyId, counterpartyId)));
              yield* transaction
                .update(counterpartyRolePeriods)
                .set({
                  state: 'ENDED',
                  isCurrent: false,
                  validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')),
                  endReason: 'private reason',
                  endEvidenceRefs: ['private evidence'],
                  endProvenanceSource: 'private source',
                  endProvenanceMethod: 'private method',
                  endedByActionInvocationId: invocationId,
                  endedByPrincipalId: principalId,
                  endedRecordedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')),
                })
                .where(
                  and(
                    eq(counterpartyRolePeriods.tenantId, tenantId),
                    eq(counterpartyRolePeriods.rolePeriodId, rolePeriodId),
                  ),
                );
              expect(yield* readCounterpartyOrganizationIcoFacts(transaction, scope, request)).toEqual(denied);
              return yield* Effect.fail('internal_counterparty_ico_facts_rollback' as const);
            }),
          )
          .pipe(Effect.result);
        expect(Result.match(done, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_counterparty_ico_facts_rollback',
        );
      }),
  );
});
