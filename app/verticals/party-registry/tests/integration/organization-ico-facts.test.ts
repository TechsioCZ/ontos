import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { DateTime, Effect, Schema, Result } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  OrganizationIcoFieldContractVersion,
  OrganizationIcoProjectionFields,
} from '../../shared/apis/organization-ico-facts.ts';
import { parties, partyFactAssertions, partyOfficialIdentifiers, partyRelations } from '../../src/db/schema.ts';
import {
  loadLegacyIcoInventory,
  legacyIcoAuthorityService,
  findLegacyIcoFence,
  PartyLegacyIcoPrivacy,
} from '../../src/services/legacy-ico-authority.service.ts';
import { readOrganizationIcoFacts } from '../../src/services/organization-ico-facts.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'df810000-0000-4000-8000-000000000001';
const principalId = 'df820000-0000-4000-8000-000000000001';
const legalEntityId = 'df830000-0000-4000-8000-000000000001';
const invocationId = 'df840000-0000-4000-8000-000000000001';
const organizationId = 'df850000-0000-4000-8000-000000000001';
const personId = 'df850000-0000-4000-8000-000000000002';
const unresolvedId = 'df850000-0000-4000-8000-000000000003';
const instant = '2020-01-01T00:00:00.000Z';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native organization ICO facts prove one current canonical ORG type and revision without exempting PERSON, unresolved, stale, conflicting or foreign facts',
    () =>
      Effect.gen(function* organizationFactsTest() {
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
            authContextRef: 'session:internal-organization-facts-fixture',
          })),
          correlationId: 'internal-organization-facts-fixture',
        };
        const rolledBack = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* organizationFactsTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              yield* transaction.insert(parties).values([
                { tenantId, partyId: organizationId, currentType: 'ORGANIZATION', revision: 5 },
                { tenantId, partyId: personId, currentType: 'PERSON', revision: 3 },
                { tenantId, partyId: unresolvedId, currentType: 'UNRESOLVED', revision: 2 },
              ]);
              const provenance = {
                tenantId,
                provenanceSource: 'internal-classification-fixture',
                provenanceMethod: 'DECLARATION',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'internal-fixture',
                factKind: 'PARTY_TYPE',
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
              };
              yield* transaction.insert(partyFactAssertions).values([
                { ...provenance, partyId: organizationId, normalizedValue: 'ORGANIZATION' },
                { ...provenance, partyId: personId, normalizedValue: 'PERSON' },
                { ...provenance, partyId: unresolvedId, normalizedValue: 'UNRESOLVED' },
              ]);
              const request = {
                partyRef: {
                  moduleId: 'party.registry' as const,
                  resourceType: 'party.registry.party' as const,
                  resourceId: organizationId,
                  tenantId,
                },
                expectedPartyRevision: 5,
                fieldContractVersion: OrganizationIcoFieldContractVersion,
              };
              const proof = yield* readOrganizationIcoFacts(transaction, scope, request);
              assert.isOk(proof.outcome === 'CURRENT_ORGANIZATION');
              expect(proof.partyRevision).toBe(5);
              expect(proof.allowedFields).toEqual(OrganizationIcoProjectionFields);
              expect(proof).not.toHaveProperty('firstName');
              expect(proof).not.toHaveProperty('provenance');
              expect(proof).not.toHaveProperty('acceptedByPrincipalId');
              const icoFixture = {
                tenantId,
                identifierTypeKey: 'ICO',
                namespace: 'CZ:ICO',
                normalizedValue: '01000004',
                originalInputDigits: '1000004',
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                provenanceSource: 'private human/source free text',
                provenanceMethod: 'private method text',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'internal-fixture',
              };
              yield* transaction.insert(partyOfficialIdentifiers).values({ ...icoFixture, partyId: organizationId });
              const companyProjection = 'ORGANIZATION_ICO_FIELDS_V1' as const;
              const explicitCompanyPolicy = {
                authorize: () =>
                  Effect.succeed({ outcome: 'ALLOWED' as const, organizationOnlyPartyIds: [organizationId] }),
              };
              const fullOrganization = yield* loadLegacyIcoInventory(transaction, scope).pipe(
                Effect.provideService(PartyLegacyIcoPrivacy, { authorize: () => Effect.succeed('ALLOWED') }),
              );
              const companyOnly = yield* loadLegacyIcoInventory(transaction, scope, companyProjection).pipe(
                Effect.provideService(PartyLegacyIcoPrivacy, explicitCompanyPolicy),
              );
              expect(companyOnly.snapshotVersion).toBe(fullOrganization.snapshotVersion);
              expect(companyOnly.assertions).toHaveLength(1);
              expect(companyOnly.assertions[0]?.provenance).toEqual({
                ownerReceiptRef: companyOnly.assertions[0]?.assertionRef,
              });
              expect(
                Result.isFailure(
                  yield* loadLegacyIcoInventory(transaction, scope, companyProjection).pipe(
                    Effect.provideService(PartyLegacyIcoPrivacy, { authorize: () => Effect.succeed('ALLOWED') }),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              yield* transaction
                .update(parties)
                .set({ currentType: 'PERSON', revision: 6 })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, organizationId)));
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'PERSON' })
                .where(
                  and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, organizationId)),
                );
              const authority = yield* legacyIcoAuthorityService(transaction, scope);
              const changedTypeFence = yield* authority
                .fence(
                  {
                    expectedSnapshotVersion: companyOnly.snapshotVersion,
                    migrationPlanRef: 'internal-company-only-plan',
                    projection: companyProjection,
                  },
                  invocationId,
                )
                .pipe(Effect.provideService(PartyLegacyIcoPrivacy, explicitCompanyPolicy), Effect.result);
              expect(Result.isFailure(changedTypeFence)).toBe(true);
              expect(yield* findLegacyIcoFence(transaction, tenantId)).toBeUndefined();
              yield* transaction
                .update(parties)
                .set({ currentType: 'ORGANIZATION', revision: 5 })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, organizationId)));
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'ORGANIZATION' })
                .where(
                  and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, organizationId)),
                );
              yield* transaction.insert(partyOfficialIdentifiers).values({ ...icoFixture, partyId: personId });
              expect(
                Result.isFailure(
                  yield* loadLegacyIcoInventory(transaction, scope, companyProjection).pipe(
                    Effect.provideService(PartyLegacyIcoPrivacy, {
                      authorize: () =>
                        Effect.die(
                          'Company projection must reject mixed PERSON before any provider or payload selection',
                        ),
                    }),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              const full = yield* loadLegacyIcoInventory(transaction, scope).pipe(
                Effect.provideService(PartyLegacyIcoPrivacy, { authorize: () => Effect.succeed('ALLOWED') }),
              );
              const safe = yield* loadLegacyIcoInventory(transaction, scope).pipe(
                Effect.provideService(PartyLegacyIcoPrivacy, {
                  authorize: () =>
                    Effect.succeed({ outcome: 'ALLOWED' as const, organizationOnlyPartyIds: [organizationId] }),
                }),
              );
              expect(safe.snapshotVersion).toBe(full.snapshotVersion);
              const company = safe.assertions.find((item) => item.partyRef.resourceId === organizationId);
              assert.isOk(company);
              expect(company.provenance).toEqual({ ownerReceiptRef: company.assertionRef });
              expect(company.provenance).not.toHaveProperty('acceptedByPrincipalId');
              expect(company.provenance).not.toHaveProperty('source');
              expect(company.originalInput).toEqual({ kind: 'KNOWN', digits: '1000004' });
              expect(safe.assertions.find((item) => item.partyRef.resourceId === personId)?.provenance).toMatchObject({
                source: 'private human/source free text',
                acceptedByPrincipalId: principalId,
              });
              expect(
                Result.isFailure(
                  yield* loadLegacyIcoInventory(transaction, scope).pipe(
                    Effect.provideService(PartyLegacyIcoPrivacy, {
                      authorize: () =>
                        Effect.succeed({ outcome: 'ALLOWED' as const, organizationOnlyPartyIds: [personId] }),
                    }),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              const rejected = {
                outcome: 'NOT_CURRENT_ORGANIZATION',
                fieldContractVersion: OrganizationIcoFieldContractVersion,
              };
              expect(
                yield* readOrganizationIcoFacts(transaction, scope, { ...request, expectedPartyRevision: 4 }),
              ).toEqual(rejected);
              expect(
                yield* readOrganizationIcoFacts(transaction, scope, {
                  ...request,
                  partyRef: { ...request.partyRef, resourceId: personId },
                  expectedPartyRevision: 3,
                }),
              ).toEqual(rejected);
              expect(
                yield* readOrganizationIcoFacts(transaction, scope, {
                  ...request,
                  partyRef: { ...request.partyRef, resourceId: unresolvedId },
                  expectedPartyRevision: 2,
                }),
              ).toEqual(rejected);
              expect(
                yield* readOrganizationIcoFacts(transaction, scope, {
                  ...request,
                  partyRef: { ...request.partyRef, tenantId: 'df810000-0000-4000-8000-000000000002' },
                }),
              ).toEqual(rejected);
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'PERSON' })
                .where(
                  and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, organizationId)),
                );
              expect(yield* readOrganizationIcoFacts(transaction, scope, request)).toEqual(rejected);
              yield* transaction
                .update(partyFactAssertions)
                .set({
                  normalizedValue: 'ORGANIZATION',
                  validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2100-01-01T00:00:00Z')),
                })
                .where(
                  and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, organizationId)),
                );
              expect(yield* readOrganizationIcoFacts(transaction, scope, request)).toEqual(rejected);
              yield* transaction
                .update(partyFactAssertions)
                .set({
                  validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                  state: 'ENDED',
                  isCurrent: false,
                  validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')),
                })
                .where(
                  and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.partyId, organizationId)),
                );
              expect(yield* readOrganizationIcoFacts(transaction, scope, request)).toEqual(rejected);
              return yield* Effect.fail('internal_organization_facts_fixture_rollback' as const);
            }),
          )
          .pipe(Effect.result);
        expect(Result.match(rolledBack, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_organization_facts_fixture_rollback',
        );
      }),
  );
});
