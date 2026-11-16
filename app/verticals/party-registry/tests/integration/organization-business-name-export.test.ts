import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { and, eq } from 'drizzle-orm';
import { ConfigProvider, DateTime, Effect, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';
import { makeTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { OrganizationBusinessSourceStatement } from '../../shared/apis/organization-record-facts.ts';
import { PartyCandidateSchema, PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import { parties, partyFactAssertions, partyRelations } from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import type { SourceIntent } from '../../src/services/party-client-source-evidence.service.ts';
import {
  createOrMatchParty,
  recordSourceCreateReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import { readOrganizationBusinessNameExport } from '../../src/services/organization-business-name-export.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'dfd10000-0000-4000-8000-000000000001';
const principalId = 'dfd20000-0000-4000-8000-000000000001';
const legalEntityId = 'dfd30000-0000-4000-8000-000000000001';
const invocationId = 'dfd40000-0000-4000-8000-000000000001';
const source = {
  issuer: 'internal-business-name-fixture',
  namespace: 'customers',
  recordType: 'organization',
  routeRef: 'internal-business-name-route',
};
const sourceReference = { source, recordId: 'organization-record', occurrenceId: 'original-accepted-occurrence' };
const instant = '2020-01-01T00:00:00.000Z';
const notCurrent = { outcome: 'UNAVAILABLE', reason: 'NOT_CURRENT_SOURCE_ORGANIZATION' };

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native corporate name export requires exact original citation and corporate policy before only current BUSINESS_NAME truth',
    () =>
      Effect.gen(function* businessNameExportFixture() {
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
            authContextRef: 'api_key:internal-business-name-fixture',
          })),
          correlationId: 'internal-business-name-fixture',
        };
        const bindings = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
          { ...source, authMethod: 'api_key', principalId, tenantId },
        ]);
        const candidate = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)({
          partyType: 'ORGANIZATION',
          businessName: 'Actual native organization name',
          evidenceRefs: [],
          officialIdentifiers: [],
          validFrom: instant,
          provenance: { source: source.routeRef, method: 'CLIENT_SOURCE_ASSERTION' },
          subjectEvidence: [
            {
              kind: 'CLIENT_SOURCE_ASSERTION',
              observedSubject: 'ORGANIZATION',
              statement: OrganizationBusinessSourceStatement,
              subjectKey: sourceReference.recordId,
              ...sourceReference,
              sourceObservedAt: instant,
            },
          ],
        });
        const rollback = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* corporateNameTransaction() {
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
              const request = { partyRef: created.partyRef, sourceReference };
              expect(yield* readOrganizationBusinessNameExport(transaction, scope, request)).toEqual(notCurrent);
              yield* recordSourceCreateReceipt(transaction, scope, invocationId, created.decisionRef.resourceId);
              expect(
                Result.isFailure(
                  yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(Effect.result),
                ),
              ).toBe(true);
              expect(
                Result.isFailure(
                  yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(
                    Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('DENIED') }),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              const approved = {
                checkImport: ({ intent }: { readonly intent: SourceIntent }) => {
                  assert.isOk(intent.operation === 'ORGANIZATION_BUSINESS_NAME_EXPORT');
                  expect(intent.target).toEqual({ kind: 'PARTY', partyId: created.partyRef.resourceId });
                  return Effect.succeed('ORGANIZATION_BUSINESS_ALLOWED' as const);
                },
              };
              // The Party projection is deliberately different: only the native assertion may be exported.
              yield* transaction
                .update(parties)
                .set({ businessName: 'Stale projection is not an assertion' })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              const current = yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(
                Effect.provideService(PartyClientSourcePrivacy, approved),
              );
              assert.isOk(current.outcome === 'CURRENT_ORGANIZATION_BUSINESS_NAME');
              assert.isOk(current.businessName.outcome === 'AVAILABLE');
              expect(current.businessName.value).toBe('Actual native organization name');
              expect(current.sourceCitation).toEqual({
                sourceDecisionRef: created.decisionRef,
                sourceActionInvocationId: invocationId,
                originalOccurrenceId: sourceReference.occurrenceId,
              });
              expect(current).not.toHaveProperty('contacts');
              expect(current).not.toHaveProperty('firstName');
              expect(current).not.toHaveProperty('provenance');
              expect(
                yield* readOrganizationBusinessNameExport(transaction, scope, {
                  ...request,
                  sourceReference: { ...sourceReference, occurrenceId: 'uncommitted-later-occurrence' },
                }),
              ).toEqual(notCurrent);
              expect(
                Result.isFailure(
                  yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(
                    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              const raced = yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(
                Effect.provideService(PartyClientSourcePrivacy, {
                  checkImport: () =>
                    transaction
                      .update(parties)
                      .set({ revision: current.partyRevision + 1 })
                      .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)))
                      .pipe(
                        Effect.mapError((cause) =>
                          Object.assign(
                            new PartyPersistenceUnavailable({
                              code: 'party_persistence_unavailable',
                              reason: 'Internal native race fixture unavailable',
                            }),
                            { cause },
                          ),
                        ),
                        Effect.as('ORGANIZATION_BUSINESS_ALLOWED' as const),
                      ),
                }),
                Effect.result,
              );
              expect(Result.isFailure(raced)).toBe(true);
              yield* transaction
                .update(parties)
                .set({ revision: current.partyRevision })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              const nameId = current.businessName.assertionId;
              yield* transaction
                .update(partyFactAssertions)
                .set({ state: 'RETRACTED', isCurrent: false })
                .where(and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.assertionId, nameId)));
              expect(
                yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(
                  Effect.provideService(PartyClientSourcePrivacy, approved),
                ),
              ).toEqual({
                ...current,
                businessName: { outcome: 'UNAVAILABLE', reason: 'NO_CURRENT_BUSINESS_NAME' },
              });
              yield* transaction
                .update(partyFactAssertions)
                .set({ state: 'ACTIVE', isCurrent: true })
                .where(and(eq(partyFactAssertions.tenantId, tenantId), eq(partyFactAssertions.assertionId, nameId)));
              const [duplicate] = yield* transaction
                .insert(partyFactAssertions)
                .values({
                  tenantId,
                  partyId: created.partyRef.resourceId,
                  factKind: 'BUSINESS_NAME',
                  normalizedValue: 'Conflicting current name',
                  validFrom: DateTime.toDateUtc(DateTime.makeUnsafe(instant)),
                  provenanceSource: 'internal-business-name-fixture',
                  provenanceMethod: 'DECLARATION',
                  acceptedByActionInvocationId: invocationId,
                  acceptedByPrincipalId: principalId,
                  policyVersion: 'internal-fixture',
                })
                .returning({ assertionId: partyFactAssertions.assertionId });
              assert.isOk(duplicate);
              expect(
                Result.isFailure(
                  yield* readOrganizationBusinessNameExport(transaction, scope, request).pipe(
                    Effect.provideService(PartyClientSourcePrivacy, approved),
                    Effect.result,
                  ),
                ),
              ).toBe(true);
              yield* transaction
                .update(partyFactAssertions)
                .set({ state: 'RETRACTED', isCurrent: false })
                .where(
                  and(
                    eq(partyFactAssertions.tenantId, tenantId),
                    eq(partyFactAssertions.assertionId, duplicate.assertionId),
                  ),
                );
              yield* transaction
                .update(parties)
                .set({ currentType: 'PERSON' })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              expect(yield* readOrganizationBusinessNameExport(transaction, scope, request)).toEqual(notCurrent);
              return yield* Effect.fail('internal_business_name_export_rollback' as const);
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: bindings }),
              ),
              Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('ALLOWED') }),
            ),
          )
          .pipe(Effect.result);
        expect(Result.match(rollback, { onFailure: (failure) => failure, onSuccess: () => null })).toBe(
          'internal_business_name_export_rollback',
        );
      }),
  );
});
