import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq, sql } from 'drizzle-orm';
import { ConfigProvider, DateTime, Effect, Schema, Result } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { SourcePersonAdmissionRequestSchema } from '../../shared/apis/source-person-admission.ts';
import { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { counterparties, counterpartyRolePeriods, partyContactPoints, partyRelations } from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import {
  createOrMatchParty,
  matchParty,
  recordSourceCreateReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import { readSourcePersonAdmission } from '../../src/services/source-person-admission.service.ts';
import { readSourceProfileExport } from '../../src/services/source-profile-export.service.ts';
import { readSourceCounterpartyAdmission } from '../../src/services/source-counterparty-admission.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'df610000-0000-4000-8000-000000000001';
const principalId = 'df620000-0000-4000-8000-000000000001';
const legalEntityId = 'df630000-0000-4000-8000-000000000001';
const invocationId = 'df640000-0000-4000-8000-000000000001';
const counterpartyId = 'df650000-0000-4000-8000-000000000001';
const rolePeriodId = 'df660000-0000-4000-8000-000000000001';
const source = {
  issuer: 'internal-source-admission-fixture',
  namespace: 'customers',
  recordType: 'person',
  routeRef: 'internal-source-admission-route',
};
const instant = '2020-01-01T00:00:00.000Z';

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native source proof uses real accepted source occurrence/receipt and current PERSON, contact and CUSTOMER facts, rejecting missing authority and ended roles',
    () =>
      Effect.gen(function* nativeSourceReads() {
        const clients = yield* openPartyBoundaryClients({ runtimeMaxConnections: 2 });
        const { runtime } = yield* openBoundaryDatabases(
          (client) => makeTestDatabaseFromClient(client, partyRelations),
          clients,
        );
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const scope = {
          ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            authMethod: 'api_key',
            authBindingId: principalId,
            authContextRef: 'api_key:internal-fixture',
            tenantId,
            legalEntityId,
            principalId,
          })),
          correlationId: 'internal-source-admission-fixture',
        };
        const bindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
          { ...source, authMethod: 'api_key', principalId, tenantId },
        ]);
        const sourceConfig = ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: bindings });
        const candidate = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)({
          partyType: 'PERSON',
          firstName: 'Internal fixture first',
          lastName: 'Internal fixture last',
          officialIdentifiers: [],
          evidenceRefs: [],
          provenance: { source: 'internal-fixture', method: 'CLIENT_SOURCE_ASSERTION' },
          validFrom: instant,
          subjectEvidence: [
            {
              kind: 'CLIENT_SOURCE_ASSERTION',
              observedSubject: 'PERSON',
              statement: 'Internal fixture source declares this person',
              subjectKey: 'fixture-person',
              source,
              recordId: 'person-record',
              occurrenceId: 'person-revision',
              sourceObservedAt: instant,
            },
          ],
        });
        const completed = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* sourceTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const created = yield* createOrMatchParty(transaction, {
                actionInvocationId: invocationId,
                candidate,
                principalId,
                sourceScope: scope,
                legalEntityId,
                tenantId,
              });
              assert.isOk(created.outcome === 'CREATED');
              const request = yield* Schema.decodeUnknownEffect(SourcePersonAdmissionRequestSchema)({
                partyRef: created.partyRef,
                sourceReference: { source, recordId: 'person-record', occurrenceId: 'person-revision' },
              });
              // A second scoped reader must not wait for the original Party transaction's identity lock.
              const duringWriter = yield* runtime.transaction((reader) =>
                Effect.gen(function* parallelMetadataRead() {
                  yield* reader.execute(sql`set local statement_timeout = '2s'`, 'objects');
                  yield* establishPartyGatewayScope(reader, grant);
                  return yield* readSourcePersonAdmission(reader, scope, request);
                }),
              );
              expect(duringWriter).toEqual({ outcome: 'NOT_ADMISSIBLE' });
              expect(yield* readSourcePersonAdmission(transaction, scope, request)).toEqual({
                outcome: 'NOT_ADMISSIBLE',
              });
              yield* recordSourceCreateReceipt(transaction, scope, invocationId, created.decisionRef.resourceId);
              const sourceMatchInvocation = 'df640000-0000-4000-8000-000000000002';
              const matched = yield* matchParty(transaction, {
                actionInvocationId: sourceMatchInvocation,
                candidate,
                tenantId,
                legalEntityId,
                sourceScope: scope,
              });
              assert.isOk(matched.outcome === 'MATCHED');
              yield* recordSourceCreateReceipt(
                transaction,
                scope,
                sourceMatchInvocation,
                matched.decisionRef.resourceId,
              );

              expect(yield* readSourcePersonAdmission(transaction, scope, request)).toMatchObject({
                outcome: 'SOURCE_PERSON_CURRENT',
                partyRef: created.partyRef,
                partyRevision: 1,
                sourceDecisionRef: created.decisionRef,
                sourceActionInvocationId: invocationId,
              });
              expect(
                yield* readSourcePersonAdmission(transaction, scope, {
                  ...request,
                  sourceReference: { ...request.sourceReference, occurrenceId: 'wrong-revision' },
                }),
              ).toEqual({ outcome: 'NOT_ADMISSIBLE' });
              expect(
                Result.isFailure(
                  yield* readSourcePersonAdmission(transaction, scope, request).pipe(
                    Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('DENIED') }),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              yield* transaction.insert(partyContactPoints).values({
                tenantId,
                partyId: created.partyRef.resourceId,
                contactPointType: 'EMAIL',
                displayValue: 'Fixture@example.test',
                normalizedValue: 'fixture@example.test',
                normalizationVersion: 'email.v1',
                privacyClassification: 'PERSONAL',
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                provenanceSource: 'internal-fixture',
                provenanceMethod: 'DECLARATION',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              });
              const exported = yield* readSourceProfileExport(transaction, scope, request);
              assert.isOk(exported.outcome === 'AVAILABLE');
              expect(exported.firstName).toBe('Internal fixture first');
              expect(exported.lastName).toBe('Internal fixture last');
              expect(exported.contactPoints.map((item) => item.normalizedValue)).toEqual(['fixture@example.test']);
              expect(exported.unsupported).toEqual(['ADDRESSES']);
              expect(
                Result.isFailure(
                  yield* readSourceProfileExport(transaction, scope, request).pipe(
                    Effect.provideService(PartyClientSourcePrivacy, {
                      checkImport: ({ intent }) =>
                        Effect.succeed('target' in intent && intent.target !== undefined ? 'DENIED' : 'ALLOWED'),
                    }),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              yield* transaction.insert(counterparties).values({
                tenantId,
                legalEntityId,
                partyId: created.partyRef.resourceId,
                counterpartyId,
                creationReason: 'internal-fixture',
                evidenceRefs: ['internal-fixture'],
                sourceRecordRefs: [],
                provenanceSource: 'internal-fixture',
                provenanceMethod: 'DECLARATION',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              });
              const customerRequest = {
                counterpartyRef: {
                  moduleId: 'party.registry' as const,
                  resourceType: 'party.registry.counterparty' as const,
                  resourceId: counterpartyId,
                  tenantId,
                },
                sourceReference: request.sourceReference,
              };
              expect(yield* readSourceCounterpartyAdmission(transaction, scope, customerRequest)).toEqual({
                outcome: 'NOT_ADMISSIBLE',
              });
              yield* transaction.insert(counterpartyRolePeriods).values({
                tenantId,
                legalEntityId,
                counterpartyId,
                rolePeriodId,
                roleType: 'CUSTOMER',
                isCurrent: true,
                addReason: 'internal-fixture',
                addEvidenceRefs: ['internal-fixture'],
                validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                provenanceSource: 'internal-fixture',
                provenanceMethod: 'DECLARATION',
                acceptedByActionInvocationId: invocationId,
                acceptedByPrincipalId: principalId,
                policyVersion: 'fixture',
              });
              const admitted = yield* readSourceCounterpartyAdmission(transaction, scope, customerRequest);
              assert.isOk(admitted.outcome === 'CUSTOMER_CURRENT');
              expect(admitted.partyRef).toEqual(created.partyRef);
              expect(admitted.legalEntityRef.resourceId).toBe(legalEntityId);
              expect(admitted.currentCustomerRoleRef.resourceId).toBe(rolePeriodId);
              expect(admitted.counterpartyRevision).toHaveLength(64);
              const wrongScope = {
                ...scope,
                legalEntityId: yield* Schema.decodeEffect(Schema.String.pipe(Schema.brand('LegalEntityId')))(
                  'df630000-0000-4000-8000-000000000002',
                ),
              };
              expect(yield* readSourceCounterpartyAdmission(transaction, wrongScope, customerRequest)).toEqual({
                outcome: 'NOT_ADMISSIBLE',
              });
              yield* transaction
                .update(counterpartyRolePeriods)
                .set({
                  state: 'ENDED',
                  isCurrent: false,
                  validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')),
                  endReason: 'internal-fixture',
                  endProvenanceSource: 'internal-fixture',
                  endProvenanceMethod: 'DECLARATION',
                  endEvidenceRefs: ['internal-fixture'],
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
              expect(yield* readSourceCounterpartyAdmission(transaction, scope, customerRequest)).toEqual({
                outcome: 'NOT_ADMISSIBLE',
              });
              return yield* Effect.fail('internal_source_fixture_rollback' as const);
            }).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, sourceConfig),
              Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('ALLOWED') }),
            ),
          )
          .pipe(Effect.result);
        expect(Result.match(completed, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_source_fixture_rollback',
        );
      }),
  );
});
