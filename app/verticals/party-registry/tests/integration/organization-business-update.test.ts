import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { EffectLogger } from 'drizzle-orm/effect-core';
import { DefaultServices, make } from 'drizzle-orm/effect-postgres';
import { ConfigProvider, DateTime, Effect, Layer, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { UpdatePartyPayloadSchema } from '../../shared/actions/update-party.ts';
import {
  OrganizationBusinessSourceStatement,
  OrganizationBusinessPartyUpdatedSchema,
  OrganizationBusinessUpdateInputSchema,
} from '../../shared/apis/organization-record-facts.ts';
import { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { parties, partyFactAssertions, partyRelations, partySourceEffectReceipts } from '../../src/db/schema.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import { lockTenantIdentityWrites } from '../../src/services/party-identifier-claim.service.ts';
import {
  createOrMatchParty,
  recordSourceCreateReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import {
  updateOrganizationBusinessRecord,
  OrganizationBusinessUpdateOutcomeSchema,
} from '../../src/services/organization-business-update.service.ts';
import { preparePartySourceEffect } from '../../src/services/party-source-effect.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'bb110000-0000-4000-8000-000000000001';
const legalEntityId = 'bb120000-0000-4000-8000-000000000001';
const principalId = 'bb130000-0000-4000-8000-000000000001';
const createInvocation = 'bb140000-0000-4000-8000-000000000001';
const updateInvocation = 'bb140000-0000-4000-8000-000000000002';
const sentinelFirst = 'PRIVATE LEGACY FIRST SENTINEL';
const sentinelLast = 'PRIVATE LEGACY LAST SENTINEL';
const source = {
  issuer: 'internal-org-update',
  namespace: 'organizations',
  recordType: 'customer',
  routeRef: 'internal-org-route',
};
const assertion = {
  kind: 'CLIENT_SOURCE_ASSERTION' as const,
  source,
  recordId: 'organization-1',
  subjectKey: 'organization-1',
  observedSubject: 'ORGANIZATION' as const,
  statement: OrganizationBusinessSourceStatement,
  sourceObservedAt: '2020-01-01T00:00:00.000Z',
  occurrenceId: 'create-1',
};
const services = NodeCrypto.layer.pipe(Layer.provideMerge(DefaultServices));

it.layer(services, { excludeTestServices: true })((suite) => {
  suite.effect(
    'bounded source organization update never reads or returns legacy personal fields and keeps original minimal receipts',
    () =>
      Effect.gen(function* nativeBusinessUpdate() {
        const clients = yield* openPartyBoundaryClients();
        let recording = false;
        const queries: { readonly query: string; readonly params: unknown[] }[] = [];
        const { runtime } = yield* openBoundaryDatabases(
          (client) =>
            make({ relations: partyRelations }).pipe(
              Effect.provideService(PgClient.PgClient, client),
              Effect.provideService(EffectLogger, {
                logQuery: (query, params) =>
                  Effect.sync(() => {
                    if (recording) {
                      queries.push({ query, params });
                    }
                  }),
              }),
            ),
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
            authContextRef: 'api_key:internal-bounded-organization-update',
          })),
          correlationId: 'internal-bounded-organization-update',
        };
        const configured = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))([
          { ...source, tenantId, principalId, authMethod: 'api_key' },
        ]);
        const completed = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* boundedUpdateTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const candidate = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)({
                partyType: 'ORGANIZATION',
                businessName: 'Internal original organization',
                officialIdentifiers: [],
                evidenceRefs: [],
                provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: source.routeRef },
                validFrom: '2020-01-01T00:00:00.000Z',
                subjectEvidence: [assertion],
              });
              const created = yield* createOrMatchParty(transaction, {
                tenantId,
                principalId,
                legalEntityId,
                actionInvocationId: createInvocation,
                candidate,
                sourceScope: scope,
              });
              assert.isOk(created.outcome === 'CREATED');
              yield* recordSourceCreateReceipt(transaction, scope, createInvocation, created.decisionRef.resourceId);
              yield* transaction
                .update(parties)
                .set({
                  firstName: sentinelFirst,
                  lastName: sentinelLast,
                  currentDisplayName: `${sentinelFirst} ${sentinelLast}`,
                })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              const payload = yield* Schema.decodeUnknownEffect(OrganizationBusinessUpdateInputSchema)({
                partyRef: created.partyRef,
                businessName: 'Internal updated organization',
                expectedRevision: 1,
                provenanceMethod: 'CLIENT_SOURCE_ASSERTION',
                provenanceSource: source.routeRef,
                validFrom: '2021-01-01T00:00:00.000Z',
                subjectEvidence: [{ ...assertion, occurrenceId: 'update-1' }],
              });
              const request = yield* Schema.encodeEffect(UpdatePartyPayloadSchema)(payload);
              const input = {
                payload,
                tenantId,
                principalId,
                actionInvocationId: updateInvocation,
                sourceScope: scope,
                request,
              };
              yield* lockTenantIdentityWrites(transaction, tenantId);
              const prepared = yield* preparePartySourceEffect(transaction, {
                ...input,
                partyId: created.partyRef.resourceId,
                operation: 'UPDATE',
                subjectEvidence: payload.subjectEvidence,
              });
              assert.isOk(prepared !== undefined);
              recording = true;
              const updated = yield* updateOrganizationBusinessRecord(transaction, input, prepared);
              recording = false;
              assert.isOk(Schema.is(OrganizationBusinessUpdateOutcomeSchema.members[0])(updated));
              expect(updated.replayed).toBe(false);
              expect(updated.result).toEqual(
                OrganizationBusinessPartyUpdatedSchema.make({ partyRef: created.partyRef, revision: 2 }),
              );
              const original = yield* preparePartySourceEffect(transaction, {
                ...input,
                partyId: created.partyRef.resourceId,
                operation: 'UPDATE',
                subjectEvidence: payload.subjectEvidence,
              });
              assert.isOk(original !== undefined);
              recording = true;
              const replay = yield* updateOrganizationBusinessRecord(
                transaction,
                { ...input, actionInvocationId: createInvocation },
                original,
              );
              recording = false;
              expect(replay).toEqual({ ...updated, replayed: true });
              for (const [occurrenceId, validFrom, expectedRevision] of [
                ['wrong-revision', '2021-01-01T00:00:00.000Z', 99],
                ['future', '2099-01-01T00:00:00.000Z', 2],
                ['backdated', '2020-01-01T00:00:00.000Z', 2],
              ] as const) {
                const rejectedPayload = yield* Schema.decodeUnknownEffect(OrganizationBusinessUpdateInputSchema)({
                  ...(yield* Schema.encodeEffect(OrganizationBusinessUpdateInputSchema)(payload)),
                  expectedRevision,
                  validFrom,
                  subjectEvidence: [{ ...assertion, occurrenceId }],
                });
                const rejectedInput = {
                  ...input,
                  payload: rejectedPayload,
                  request: yield* Schema.encodeEffect(UpdatePartyPayloadSchema)(rejectedPayload),
                };
                const checked = yield* preparePartySourceEffect(transaction, {
                  ...rejectedInput,
                  partyId: created.partyRef.resourceId,
                  operation: 'UPDATE',
                  subjectEvidence: rejectedPayload.subjectEvidence,
                });
                assert.isOk(checked !== undefined);
                recording = true;
                expect(
                  Schema.is(OrganizationBusinessUpdateOutcomeSchema.members[1])(
                    yield* updateOrganizationBusinessRecord(transaction, rejectedInput, checked),
                  ),
                ).toBe(true);
                recording = false;
              }
              const [stored] = yield* transaction
                .select({
                  firstName: parties.firstName,
                  lastName: parties.lastName,
                  displayName: parties.currentDisplayName,
                  businessName: parties.businessName,
                  revision: parties.revision,
                })
                .from(parties)
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              expect(stored).toEqual({
                firstName: sentinelFirst,
                lastName: sentinelLast,
                displayName: payload.businessName,
                businessName: payload.businessName,
                revision: 2,
              });
              const facts = yield* transaction
                .select({
                  state: partyFactAssertions.state,
                  current: partyFactAssertions.isCurrent,
                  until: partyFactAssertions.validTo,
                  evaluation: partyFactAssertions.evidenceEvaluation,
                  method: partyFactAssertions.provenanceMethod,
                  principal: partyFactAssertions.acceptedByPrincipalId,
                  invocation: partyFactAssertions.acceptedByActionInvocationId,
                })
                .from(partyFactAssertions)
                .where(
                  and(
                    eq(partyFactAssertions.tenantId, tenantId),
                    eq(partyFactAssertions.partyId, created.partyRef.resourceId),
                    eq(partyFactAssertions.factKind, 'BUSINESS_NAME'),
                  ),
                );
              expect(facts).toHaveLength(2);
              expect(facts.find(({ current }) => !current)).toMatchObject({
                state: 'ENDED',
                until: DateTime.toDateUtc(payload.validFrom),
              });
              expect(facts.find(({ current }) => current)).toMatchObject({
                state: 'ACTIVE',
                until: null,
                method: 'CLIENT_SOURCE_ASSERTION',
                principal: principalId,
                invocation: updateInvocation,
                evaluation: { subjectEligible: true, typeSupported: true },
              });
              const receipts = yield* transaction
                .select({ result: partySourceEffectReceipts.result })
                .from(partySourceEffectReceipts)
                .where(eq(partySourceEffectReceipts.tenantId, tenantId));
              expect(receipts).toEqual([{ result: { partyRef: created.partyRef, revision: 2 } }]);
              for (const command of queries.filter(({ query }) => query.startsWith('select'))) {
                for (const forbidden of [
                  'first_name',
                  'last_name',
                  'current_display_name',
                  'normalized_value',
                  'provenance_source',
                  'accepted_by_principal_id',
                ]) {
                  expect(command.query).not.toContain(forbidden);
                }
              }
              const exposed = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                updated,
                replay,
                receipts,
                queries,
              });
              expect(exposed).not.toContain(sentinelFirst);
              expect(exposed).not.toContain(sentinelLast);
              yield* transaction
                .update(parties)
                .set({ revision: 3 })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
              expect(
                Schema.is(OrganizationBusinessUpdateOutcomeSchema.members[1])(
                  yield* updateOrganizationBusinessRecord(transaction, input, original),
                ),
              ).toBe(true);
              for (const changes of [
                { revision: 2, currentType: 'PERSON' },
                { revision: 2, currentType: 'ORGANIZATION', archivedAt: DateTime.toDateUtc(payload.validFrom) },
              ]) {
                yield* transaction
                  .update(parties)
                  .set(changes)
                  .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, created.partyRef.resourceId)));
                expect(
                  Schema.is(OrganizationBusinessUpdateOutcomeSchema.members[1])(
                    yield* updateOrganizationBusinessRecord(transaction, input, original),
                  ),
                ).toBe(true);
              }
              return yield* Effect.fail('internal_bounded_organization_update_rollback' as const);
            }).pipe(
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: configured }),
              ),
              Effect.provideService(PartyClientSourcePrivacy, { checkImport: () => Effect.succeed('ALLOWED') }),
            ),
          )
          .pipe(Effect.result);
        assert.isOk(Result.isFailure(completed));
        expect(completed.failure).toBe('internal_bounded_organization_update_rollback');
      }),
  );
});
