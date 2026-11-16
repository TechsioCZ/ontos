import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { ConfigProvider, DateTime, Effect, Schema, Result } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { OrganizationBusinessSourceStatement } from '../../shared/apis/organization-record-facts.ts';
import { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import {
  counterparties,
  counterpartyRolePeriods,
  parties,
  partyFactAssertions,
  partyMatchDecisions,
  partyRelations,
} from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import {
  createOrMatchParty,
  matchParty,
  recordSourceCreateReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import { readOrganizationRecordFacts } from '../../src/services/organization-record-facts.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'dfc10000-0000-4000-8000-000000000001';
const principalId = 'dfc20000-0000-4000-8000-000000000001';
const legalEntityId = 'dfc30000-0000-4000-8000-000000000001';
const invocationId = 'dfc40000-0000-4000-8000-000000000001';
const matchedInvocationId = 'dfc40000-0000-4000-8000-000000000002';
const counterpartyId = 'dfc50000-0000-4000-8000-000000000001';
const rolePeriodId = 'dfc60000-0000-4000-8000-000000000001';
const source = {
  issuer: 'internal-org-record-fixture',
  namespace: 'customers',
  recordType: 'organization',
  routeRef: 'internal-org-record-route',
};
const sourceRecord = { source, recordId: 'organization-record' };
const instant = '2020-01-01T00:00:00.000Z';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native general organization record facts use original accepted record citation, current facts and CUSTOMER role without Privacy recursion or source fabrication',
    () =>
      Effect.gen(function* organizationRecordTest() {
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
            authMethod: 'api_key',
            authBindingId: principalId,
            authContextRef: 'api_key:internal-org-record-fixture',
          })),
          correlationId: 'internal-org-record-fixture',
        };
        const bindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
          { ...source, authMethod: 'api_key', principalId, tenantId },
        ]);
        const reviewerScope = {
          ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            tenantId,
            legalEntityId,
            principalId: 'dfc20000-0000-4000-8000-000000000002',
            authMethod: 'session',
            authBindingId: 'dfc20000-0000-4000-8000-000000000002',
            authContextRef: 'session:internal-org-record-review-fixture',
          })),
          correlationId: 'internal-org-record-review-fixture',
        };
        const foreignBindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
          { ...source, authMethod: 'api_key', principalId, tenantId: 'dfc10000-0000-4000-8000-000000000002' },
        ]);
        const config = ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: bindings });
        const candidate = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)({
          partyType: 'ORGANIZATION',
          businessName: 'Internal fixture organization',
          evidenceRefs: [],
          officialIdentifiers: [],
          validFrom: instant,
          provenance: { source: source.routeRef, method: 'CLIENT_SOURCE_ASSERTION' },
          subjectEvidence: [
            {
              kind: 'CLIENT_SOURCE_ASSERTION',
              observedSubject: 'ORGANIZATION',
              statement: OrganizationBusinessSourceStatement,
              subjectKey: sourceRecord.recordId,
              source,
              recordId: sourceRecord.recordId,
              occurrenceId: 'original-accepted-occurrence',
              sourceObservedAt: instant,
            },
          ],
        });
        const rollback = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* organizationRecordTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const created = yield* createOrMatchParty(transaction, {
                tenantId,
                legalEntityId,
                principalId,
                sourceScope: scope,
                actionInvocationId: invocationId,
                candidate,
              });
              assert.isOk(created.outcome === 'CREATED');
              const nativeRequest = { target: 'PARTY' as const, partyRef: created.partyRef };
              const plain = yield* readOrganizationRecordFacts(transaction, scope, nativeRequest);
              assert.isOk(plain.outcome === 'CURRENT_ORGANIZATION');
              expect(plain.sourceCitation).toBeNull();
              expect(plain.typeAssertionRevision).toHaveLength(64);
              expect(plain).not.toHaveProperty('businessName');
              const request = { ...nativeRequest, sourceRecord };
              expect(yield* readOrganizationRecordFacts(transaction, scope, request)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              yield* recordSourceCreateReceipt(transaction, scope, invocationId, created.decisionRef.resourceId);
              const matched = yield* matchParty(transaction, {
                tenantId,
                legalEntityId,
                sourceScope: scope,
                actionInvocationId: matchedInvocationId,
                candidate,
              });
              assert.isOk(matched.outcome === 'MATCHED');
              yield* recordSourceCreateReceipt(transaction, scope, matchedInvocationId, matched.decisionRef.resourceId);
              const current = yield* readOrganizationRecordFacts(transaction, scope, request).pipe(
                Effect.provideService(PartyClientSourcePrivacy, {
                  checkImport: () => Effect.die('Metadata organization facts must not call Privacy'),
                }),
              );
              assert.isOk(current.outcome === 'CURRENT_ORGANIZATION');
              expect(current.sourceCitation).toEqual({
                sourceDecisionRef: created.decisionRef,
                sourceActionInvocationId: invocationId,
                originalOccurrenceId: 'original-accepted-occurrence',
              });
              expect(current.sourceCitation?.originalOccurrenceId).not.toBe('incoming-uncommitted-update');
              expect(yield* readOrganizationRecordFacts(transaction, reviewerScope, request)).toEqual(current);
              yield* transaction.execute(sql`set local timezone = 'Europe/Prague'`, 'objects');
              expect(yield* readOrganizationRecordFacts(transaction, scope, request)).toEqual(current);
              expect(
                yield* readOrganizationRecordFacts(transaction, scope, {
                  ...request,
                  sourceRecord: { source, recordId: 'unknown-record' },
                }),
              ).toEqual({ outcome: 'NOT_CURRENT_ORGANIZATION' });
              expect(
                Result.isFailure(
                  yield* readOrganizationRecordFacts(transaction, scope, request).pipe(
                    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              yield* transaction.insert(counterparties).values({
                tenantId,
                legalEntityId,
                counterpartyId,
                partyId: created.partyRef.resourceId,
                creationReason: 'private fixture reason',
                evidenceRefs: ['private fixture evidence'],
                sourceRecordRefs: [],
                provenanceSource: 'private fixture source',
                provenanceMethod: 'private fixture method',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              });
              const customerRequest = {
                target: 'SOURCE_COUNTERPARTY_CUSTOMER' as const,
                counterpartyRef: {
                  moduleId: 'party.registry' as const,
                  resourceType: 'party.registry.counterparty' as const,
                  resourceId: counterpartyId,
                  tenantId,
                },
                sourceRecord,
              };
              const nativeCustomerRequest = {
                target: 'COUNTERPARTY_CUSTOMER' as const,
                counterpartyRef: customerRequest.counterpartyRef,
              };
              expect(yield* readOrganizationRecordFacts(transaction, scope, customerRequest)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              expect(yield* readOrganizationRecordFacts(transaction, scope, nativeCustomerRequest)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              yield* transaction.insert(counterpartyRolePeriods).values({
                tenantId,
                legalEntityId,
                counterpartyId,
                rolePeriodId,
                roleType: 'CUSTOMER',
                isCurrent: false,
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                addReason: 'private fixture reason',
                addEvidenceRefs: ['private fixture evidence'],
                provenanceSource: 'private fixture source',
                provenanceMethod: 'private fixture method',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              });
              const customer = yield* readOrganizationRecordFacts(transaction, scope, customerRequest);
              assert.isOk(customer.outcome === 'CURRENT_ORGANIZATION_CUSTOMER');
              expect(customer.partyRef).toEqual(created.partyRef);
              expect(customer.legalEntityRef.resourceId).toBe(legalEntityId);
              expect(customer.currentCustomerRoleRef.resourceId).toBe(rolePeriodId);
              expect(customer.counterpartyRevision).toHaveLength(64);
              expect(customer.currentCustomerRoleRevision).toHaveLength(64);
              expect(customer.sourceCitation).toEqual(current.sourceCitation);
              expect(yield* readOrganizationRecordFacts(transaction, reviewerScope, customerRequest)).toEqual(customer);
              for (const reviewRequest of [request, customerRequest]) {
                expect(
                  Result.isFailure(
                    yield* readOrganizationRecordFacts(transaction, reviewerScope, reviewRequest).pipe(
                      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
                      Effect.result,
                    ),
                  ),
                ).toBe(true);
                expect(
                  Result.isFailure(
                    yield* readOrganizationRecordFacts(transaction, reviewerScope, reviewRequest).pipe(
                      Effect.provideService(
                        ConfigProvider.ConfigProvider,
                        ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: foreignBindings }),
                      ),
                      Effect.result,
                    ),
                  ),
                ).toBe(true);
                expect(
                  Result.isFailure(
                    yield* readOrganizationRecordFacts(transaction, reviewerScope, {
                      ...reviewRequest,
                      sourceRecord: {
                        source: { ...source, namespace: 'foreign-source' },
                        recordId: sourceRecord.recordId,
                      },
                    }).pipe(Effect.result),
                  ),
                ).toBe(true);
                expect(
                  Result.isFailure(
                    yield* readOrganizationRecordFacts(
                      transaction,
                      {
                        ...scope,
                        principalId: reviewerScope.principalId,
                      },
                      reviewRequest,
                    ).pipe(Effect.result),
                  ),
                ).toBe(true);
                expect(
                  yield* readOrganizationRecordFacts(transaction, reviewerScope, {
                    ...reviewRequest,
                    sourceRecord: { ...sourceRecord, recordId: 'unknown-review-record' },
                  }),
                ).toEqual({ outcome: 'NOT_CURRENT_ORGANIZATION' });
              }
              const nativeCustomer = yield* readOrganizationRecordFacts(transaction, scope, nativeCustomerRequest).pipe(
                Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
                Effect.provideService(PartyClientSourcePrivacy, {
                  checkImport: () => Effect.die('Native canonical customer metadata must not call Privacy'),
                }),
              );
              expect(nativeCustomer).toEqual({
                ...customer,
                outcome: 'CURRENT_CANONICAL_ORGANIZATION_CUSTOMER',
                sourceCitation: null,
              });
              expect(
                yield* readOrganizationRecordFacts(
                  transaction,
                  { ...scope, legalEntityId: 'dfc30000-0000-4000-8000-000000000002' },
                  nativeCustomerRequest,
                ),
              ).toEqual({ outcome: 'NOT_CURRENT_ORGANIZATION' });
              yield* transaction
                .update(counterpartyRolePeriods)
                .set({
                  state: 'ENDED',
                  validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')),
                  endReason: 'private fixture reason',
                  endEvidenceRefs: ['private fixture evidence'],
                  endProvenanceSource: 'private fixture source',
                  endProvenanceMethod: 'private fixture method',
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
              expect(yield* readOrganizationRecordFacts(transaction, scope, nativeCustomerRequest)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              yield* transaction
                .update(counterpartyRolePeriods)
                .set({
                  state: 'ACTIVE',
                  validTo: null,
                  endReason: null,
                  endEvidenceRefs: null,
                  endProvenanceSource: null,
                  endProvenanceMethod: null,
                  endedByActionInvocationId: null,
                  endedByPrincipalId: null,
                  endedRecordedAt: null,
                })
                .where(
                  and(
                    eq(counterpartyRolePeriods.tenantId, tenantId),
                    eq(counterpartyRolePeriods.rolePeriodId, rolePeriodId),
                  ),
                );
              const [originalDecision] = yield* transaction
                .select({ evidence: partyMatchDecisions.evidenceEvaluation })
                .from(partyMatchDecisions)
                .where(eq(partyMatchDecisions.matchDecisionId, created.decisionRef.resourceId));
              assert.isOk(originalDecision?.evidence);
              const conflictingEvidence = {
                ...originalDecision.evidence,
                evidence: originalDecision.evidence.evidence.map((item) =>
                  item.kind === 'CLIENT_SOURCE_ASSERTION' ? { ...item, recordId: 'conflicting-record' } : item,
                ),
              };
              const conflictingParty = 'dfc70000-0000-4000-8000-000000000001';
              yield* transaction
                .insert(parties)
                .values({ tenantId, partyId: conflictingParty, currentType: 'ORGANIZATION' });
              const conflictA = 'dfc80000-0000-4000-8000-000000000001';
              const conflictB = 'dfc80000-0000-4000-8000-000000000002';
              const conflictInvocationA = 'dfc90000-0000-4000-8000-000000000001';
              const conflictInvocationB = 'dfc90000-0000-4000-8000-000000000002';
              yield* transaction.insert(partyMatchDecisions).values([
                {
                  tenantId,
                  matchDecisionId: conflictA,
                  actionInvocationId: conflictInvocationA,
                  candidateFingerprint: 'a'.repeat(64),
                  matchRuleVersion: 'internal-conflict-fixture',
                  operation: 'MATCH',
                  outcome: 'MATCHED',
                  partyId: created.partyRef.resourceId,
                  evidenceExplanation: [],
                  evidenceEvaluation: conflictingEvidence,
                },
                {
                  tenantId,
                  matchDecisionId: conflictB,
                  actionInvocationId: conflictInvocationB,
                  candidateFingerprint: 'b'.repeat(64),
                  matchRuleVersion: 'internal-conflict-fixture',
                  operation: 'MATCH',
                  outcome: 'MATCHED',
                  partyId: conflictingParty,
                  evidenceExplanation: [],
                  evidenceEvaluation: conflictingEvidence,
                },
              ]);
              yield* recordSourceCreateReceipt(transaction, scope, conflictInvocationA, conflictA);
              yield* recordSourceCreateReceipt(transaction, scope, conflictInvocationB, conflictB);
              expect(
                yield* readOrganizationRecordFacts(transaction, scope, {
                  ...request,
                  sourceRecord: { source, recordId: 'conflicting-record' },
                }),
              ).toEqual({ outcome: 'NOT_CURRENT_ORGANIZATION' });
              yield* transaction
                .update(partyMatchDecisions)
                .set({ evidenceEvaluation: null })
                .where(eq(partyMatchDecisions.tenantId, tenantId));
              expect(yield* readOrganizationRecordFacts(transaction, scope, request)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              expect(yield* readOrganizationRecordFacts(transaction, scope, customerRequest)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              expect((yield* readOrganizationRecordFacts(transaction, scope, nativeRequest)).outcome).toBe(
                'CURRENT_ORGANIZATION',
              );
              expect(yield* readOrganizationRecordFacts(transaction, scope, nativeCustomerRequest)).toEqual(
                nativeCustomer,
              );
              yield* transaction
                .update(partyFactAssertions)
                .set({ normalizedValue: 'PERSON' })
                .where(
                  and(
                    eq(partyFactAssertions.tenantId, tenantId),
                    eq(partyFactAssertions.partyId, created.partyRef.resourceId),
                  ),
                );
              expect(yield* readOrganizationRecordFacts(transaction, scope, nativeRequest)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              expect(yield* readOrganizationRecordFacts(transaction, scope, nativeCustomerRequest)).toEqual({
                outcome: 'NOT_CURRENT_ORGANIZATION',
              });
              return yield* Effect.fail('internal_org_record_fixture_rollback' as const);
            }).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, config),
              Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('ALLOWED') }),
            ),
          )
          .pipe(Effect.result);
        expect(Result.match(rollback, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_org_record_fixture_rollback',
        );
      }),
  );
});
