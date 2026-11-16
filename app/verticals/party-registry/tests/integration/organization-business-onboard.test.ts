import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  OrganizationBusinessCounterpartyContextReason,
  OrganizationBusinessCustomerRoleReason,
  OrganizationBusinessOnboardInputSchema,
} from '../../shared/apis/organization-record-facts.ts';
import {
  CounterpartyEvidenceInsufficient,
  CounterpartyScopeMismatch,
  CounterpartyTemporalConflict,
} from '../../shared/domain/counterparty-errors.ts';
import {
  counterparties,
  counterpartyAdminReadModels,
  counterpartyRolePeriods,
  counterpartyRoleAdminReadModels,
  parties,
  partyFactAssertions,
  partyRelations,
} from '../../src/db/schema.ts';
import { onboardOrganizationBusiness } from '../../src/services/organization-business-onboard.service.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
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
const acceptance = { actionInvocationId: invocationId, policyVersion: 'internal-native-onboard-fixture' };
const start = '2020-01-01T00:00:00.000Z';
const end = '2021-01-01T00:00:00.000Z';
const payload = {
  partyRef: { moduleId: 'party.registry', resourceType: 'party.registry.party', resourceId: partyId, tenantId },
  sourceReference: {
    source: {
      issuer: 'internal-onboard-fixture',
      namespace: 'customers',
      recordType: 'organization',
      routeRef: 'internal-onboard-route',
    },
    recordId: 'internal-organization',
    occurrenceId: 'internal-approved-relationship',
  },
  counterpartyProvenance: {
    method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
    source: 'internal-onboard-route',
    evidenceReference: 'internal-organization',
    reason: OrganizationBusinessCounterpartyContextReason,
  },
  customerEvidence: {
    method: 'APPROVED_PURCHASING_RELATIONSHIP',
    source: 'internal-onboard-route',
    evidenceReference: 'internal-organization',
    reason: OrganizationBusinessCustomerRoleReason,
  },
  validFrom: start,
  validTo: end,
};

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'bounded native organization onboarding preserves explicit approvals, period equivalence, overlap and minimal current facts',
    () =>
      Effect.gen(function* nativeOnboardFixture() {
        const clients = yield* openPartyBoundaryClients();
        const { runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          tenantId,
          principalId,
          legalEntityId,
          authMethod: 'session',
          authBindingId: principalId,
          authContextRef: 'session:internal-native-onboard-fixture',
        });
        const scope = { ...principal, correlationId: 'internal-native-onboard-fixture' };
        const tenantPrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
          tenantId,
          principalId,
          authMethod: 'session',
          authBindingId: principalId,
          authContextRef: 'session:internal-native-onboard-fixture',
        });
        const input = yield* Schema.decodeUnknownEffect(OrganizationBusinessOnboardInputSchema)(payload);
        expect(
          Schema.is(OrganizationBusinessOnboardInputSchema)({
            ...payload,
            counterpartyProvenance: { ...payload.counterpartyProvenance, method: 'APPROVED_PURCHASING_RELATIONSHIP' },
          }),
        ).toBe(false);
        expect(
          Schema.is(OrganizationBusinessOnboardInputSchema)({
            ...payload,
            customerEvidence: { ...payload.customerEvidence, method: 'APPROVED_COMMERCIAL_RELATIONSHIP' },
          }),
        ).toBe(false);
        expect(Schema.is(OrganizationBusinessOnboardInputSchema)({ ...payload, customerEvidence: undefined })).toBe(
          false,
        );
        expect(
          Schema.is(OrganizationBusinessOnboardInputSchema)({
            ...payload,
            customerEvidence: { ...payload.customerEvidence, evidenceReference: 'another-record' },
          }),
        ).toBe(false);
        const rollback = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* boundedNativeTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              yield* transaction.insert(parties).values({ tenantId, partyId, currentType: 'ORGANIZATION' });
              const fact = {
                tenantId,
                partyId,
                factKind: 'PARTY_TYPE',
                normalizedValue: 'ORGANIZATION',
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(start)),
                provenanceSource: 'internal-native-onboard-fixture',
                provenanceMethod: 'DECLARATION',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: acceptance.policyVersion,
              };
              yield* transaction.insert(partyFactAssertions).values(fact);
              expect(
                Schema.is(CounterpartyScopeMismatch)(
                  yield* onboardOrganizationBusiness(
                    transaction,
                    { ...tenantPrincipal, correlationId: scope.correlationId },
                    input,
                    acceptance,
                  ).pipe(Effect.flip),
                ),
              ).toBe(true);
              expect(
                Schema.is(CounterpartyScopeMismatch)(
                  yield* onboardOrganizationBusiness(
                    transaction,
                    scope,
                    {
                      ...input,
                      partyRef: { ...input.partyRef, tenantId: 'dfa10000-0000-4000-8000-000000000002' },
                    },
                    acceptance,
                  ).pipe(Effect.flip),
                ),
              ).toBe(true);
              const first = yield* onboardOrganizationBusiness(transaction, scope, input, acceptance);
              expect(first.replayed).toBe(false);
              expect(first.result.counterpartyCreated).toBe(true);
              expect(first.result.rolePeriodCreated).toBe(true);
              expect(first.result.validFrom).toBe(start);
              expect(first.result.validTo).toBe(end);
              expect(first.result).not.toHaveProperty('role');
              expect(first.result).not.toHaveProperty('provenance');
              const [contextProjection] = yield* transaction
                .select()
                .from(counterpartyAdminReadModels)
                .where(eq(counterpartyAdminReadModels.tenantId, tenantId));
              expect(contextProjection?.storedPartyId).toBe(partyId);
              const [roleProjection] = yield* transaction
                .select()
                .from(counterpartyRoleAdminReadModels)
                .where(eq(counterpartyRoleAdminReadModels.tenantId, tenantId));
              expect(roleProjection?.provenanceMethod).toBe('APPROVED_PURCHASING_RELATIONSHIP');
              expect(roleProjection?.addEvidenceRefs).toEqual(['internal-organization']);
              expect(roleProjection?.state).toBe('ENDED');
              yield* transaction
                .update(counterpartyRolePeriods)
                .set({ addReason: 'historical private text', provenanceSource: 'historical private source' })
                .where(eq(counterpartyRolePeriods.tenantId, tenantId));
              const equivalent = yield* onboardOrganizationBusiness(transaction, scope, input, acceptance);
              expect(equivalent.result).toEqual({
                ...first.result,
                counterpartyCreated: false,
                rolePeriodCreated: false,
              });
              expect(
                Schema.is(CounterpartyTemporalConflict)(
                  yield* onboardOrganizationBusiness(
                    transaction,
                    scope,
                    {
                      ...input,
                      validFrom: '2020-06-01T00:00:00.000Z',
                      validTo: '2021-06-01T00:00:00.000Z',
                    },
                    acceptance,
                  ).pipe(Effect.flip),
                ),
              ).toBe(true);
              const adjacent = yield* onboardOrganizationBusiness(
                transaction,
                scope,
                { ...input, validFrom: end, validTo: '2022-01-01T00:00:00.000Z' },
                acceptance,
              );
              expect(adjacent.result.counterpartyCreated).toBe(false);
              expect(adjacent.result.rolePeriodCreated).toBe(true);
              const emptyInput = {
                ...input,
                validFrom: '2022-01-01T00:00:00.000Z',
                validTo: '2022-01-01T00:00:00.000Z',
              };
              const empty = yield* onboardOrganizationBusiness(transaction, scope, emptyInput, acceptance);
              expect(empty.result.rolePeriodCreated).toBe(true);
              expect((yield* onboardOrganizationBusiness(transaction, scope, emptyInput, acceptance)).result).toEqual({
                ...empty.result,
                rolePeriodCreated: false,
              });
              yield* transaction
                .update(counterparties)
                .set({ archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe(end)) })
                .where(eq(counterparties.tenantId, tenantId));
              expect(
                Schema.is(CounterpartyEvidenceInsufficient)(
                  yield* onboardOrganizationBusiness(transaction, scope, input, acceptance).pipe(Effect.flip),
                ),
              ).toBe(true);
              yield* transaction
                .update(counterparties)
                .set({ archivedAt: null })
                .where(eq(counterparties.tenantId, tenantId));
              yield* transaction
                .update(parties)
                .set({ currentType: 'PERSON' })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, partyId)));
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'PERSON' })
                .where(eq(partyFactAssertions.tenantId, tenantId));
              expect(
                Schema.is(CounterpartyEvidenceInsufficient)(
                  yield* onboardOrganizationBusiness(transaction, scope, input, acceptance).pipe(Effect.flip),
                ),
              ).toBe(true);
              const [unchanged] = yield* transaction
                .select({ method: counterparties.provenanceMethod })
                .from(counterparties)
                .where(eq(counterparties.tenantId, tenantId));
              assert.isOk(unchanged);
              expect(unchanged.method).toBe('APPROVED_COMMERCIAL_RELATIONSHIP');
              return yield* Effect.fail('bounded_org_onboard_fixture_rollback' as const);
            }).pipe(
              Effect.provideService(PartyClientSourcePrivacy, {
                checkImport: () =>
                  Effect.die('Lower native onboarding fixture does not claim current source/Privacy admission'),
              }),
            ),
          )
          .pipe(Effect.result);
        expect(Result.match(rollback, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'bounded_org_onboard_fixture_rollback',
        );
      }),
  );
});
