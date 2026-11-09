import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { ConfigProvider, DateTime, Effect, Result, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { AddContactPointPayloadSchema } from '../../shared/actions/add-contact-point.ts';
import { CounterpartyCustomerOnboardPayloadSchema } from '../../shared/actions/counterparty-customer-onboard.ts';
import { EndContactPointPayloadSchema } from '../../shared/actions/end-contact-point.ts';
import { UpdateContactPointPayloadSchema } from '../../shared/actions/update-contact-point.ts';
import { PartyCandidateSchema } from '../../shared/domain/identity-contracts.ts';
import { parties, partyContactPoints, partyRelations, partySourceEffectReceipts } from '../../src/db/schema.ts';
import { CustomerOnboardFoundSchema } from '../../src/services/counterparty-persistence.service.ts';
import { PartyClientSourcePrivacy } from '../../src/services/party-client-source-evidence.service.ts';
import {
  createOrMatchParty,
  recordSourceCreateReceipt,
} from '../../src/services/party-matching-persistence.service.ts';
import {
  addContactPointSourceRecord,
  updateContactPointSourceRecord,
  endContactPointSourceRecord,
  onboardCounterpartyCustomerSourceRecord,
  recoverPartySourceLifecycleReceipt,
  SourceOnboardReplaySchema,
} from '../../src/services/party-source-lifecycle.service.ts';
import {
  openPartyBoundaryClients,
  openBoundaryDatabases,
  registerPartyGatewayScope,
  establishPartyGatewayScope,
} from '../support/database-boundary.ts';

const tenantId = 'ad110000-0000-4000-8000-000000000001';
const legalEntityId = 'ad120000-0000-4000-8000-000000000001';
const principalId = 'ad130000-0000-4000-8000-000000000001';
const createInvocation = 'ad140000-0000-4000-8000-000000000001';
const onboardingInvocation = 'ad140000-0000-4000-8000-000000000002';
const contactInvocation = 'ad140000-0000-4000-8000-000000000003';
const updateInvocation = 'ad140000-0000-4000-8000-000000000004';
const endInvocation = 'ad140000-0000-4000-8000-000000000005';
const otherInvocation = 'ad140000-0000-4000-8000-000000000006';
const instant = '2020-01-01T00:00:00.000Z';
const customerSource = {
  issuer: 'internal-lifecycle-ebs',
  namespace: 'customer-register',
  recordType: 'customer',
  routeRef: 'internal-customer-route',
};
const contactSource = { ...customerSource, namespace: 'contact-register', recordType: 'contact' };
const addressSource = { ...contactSource, recordType: 'address' };
const otherSource = { ...contactSource, issuer: 'other-internal-lifecycle-ebs' };
const customerReference = {
  source: customerSource,
  recordId: 'customer-record-1',
  occurrenceId: 'customer-revision-1',
};
const contactReference = { source: contactSource, recordId: 'address-id-1', occurrenceId: 'contact-add-1' };
const provenance = { authoritative: false, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' } as const;

it.layer(NodeCrypto.layer, { excludeTestServices: true })((suite) => {
  suite.effect(
    'native source lifecycle writes keep exact receipts, issuer targets, current Privacy and revocation through replay',
    () =>
      Effect.gen(function* nativeSourceLifecycle() {
        const clients = yield* openPartyBoundaryClients();
        const { runtime } = yield* openBoundaryDatabases(
          (client) =>
            makeWithDefaults({ relations: partyRelations }).pipe(Effect.provideService(PgClient.PgClient, client)),
          clients,
        );
        const [databaseClock] = yield* clients.admin<{
          readonly instant: string;
        }>`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as instant`;
        assert.isOk(databaseClock !== undefined);
        const grant = yield* registerPartyGatewayScope(clients, { tenantId, legalEntityId });
        const scope = {
          ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
            tenantId,
            legalEntityId,
            principalId,
            authMethod: 'api_key',
            authBindingId: principalId,
            authContextRef: 'api_key:source-lifecycle-native',
          })),
          correlationId: 'source-lifecycle-native',
        };
        const configured = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(
          [customerSource, contactSource, addressSource, otherSource].map((source) => ({
            ...source,
            tenantId,
            principalId,
            authMethod: 'api_key',
          })),
        );
        const sourceConfig = ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: configured });
        let privacyAllowed = true;
        const completed = yield* runtime
          .transaction((transaction) =>
            Effect.gen(function* lifecycleTransaction() {
              yield* establishPartyGatewayScope(transaction, grant);
              const candidate = yield* Schema.decodeUnknownEffect(PartyCandidateSchema)({
                partyType: 'ORGANIZATION',
                businessName: 'Internal lifecycle fixture',
                officialIdentifiers: [],
                evidenceRefs: [],
                provenance: { method: 'CLIENT_SOURCE_ASSERTION', source: 'internal-lifecycle' },
                validFrom: instant,
                subjectEvidence: [
                  {
                    kind: 'CLIENT_SOURCE_ASSERTION',
                    observedSubject: 'ORGANIZATION',
                    statement: 'Internal source customer declaration',
                    subjectKey: 'customer-1',
                    ...customerReference,
                    sourceObservedAt: instant,
                  },
                ],
              });
              const created = yield* createOrMatchParty(transaction, {
                tenantId,
                legalEntityId,
                principalId,
                actionInvocationId: createInvocation,
                candidate,
                sourceScope: scope,
              });
              assert.isOk(created.outcome === 'CREATED');
              yield* recordSourceCreateReceipt(transaction, scope, createInvocation, created.decisionRef.resourceId);
              const onboarding = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
                partyRef: created.partyRef,
                sourceReference: customerReference,
                validFrom: instant,
                counterpartyProvenance: {
                  source: 'internal-lifecycle',
                  method: 'SIGNED_CONTRACT',
                  evidenceReference: 'internal:commercial-agreement',
                  reason: 'Explicit fixture commercial context',
                },
                customerEvidence: {
                  source: 'internal-lifecycle',
                  method: 'BINDING_ORDER',
                  evidenceReference: 'internal:customer-order',
                },
              });
              const onboardingCommand = {
                tenantId,
                legalEntityId,
                principalId,
                actionInvocationId: onboardingInvocation,
                partyId: created.partyRef.resourceId,
                counterpartyProvenance: onboarding.counterpartyProvenance,
                customerEvidence: onboarding.customerEvidence,
                provenance: onboarding.customerEvidence,
                policyVersion: 'counterparty-customer-onboard.v1',
                validFrom: onboarding.validFrom,
                validTo: null,
              };
              const onboarded = yield* onboardCounterpartyCustomerSourceRecord(
                transaction,
                scope,
                onboarding,
                onboardingCommand,
              );
              assert.isOk(Schema.is(CustomerOnboardFoundSchema)(onboarded));
              const onboardReplay = yield* onboardCounterpartyCustomerSourceRecord(transaction, scope, onboarding, {
                ...onboardingCommand,
                actionInvocationId: otherInvocation,
              });
              assert.isOk(Schema.is(SourceOnboardReplaySchema)(onboardReplay));
              expect(onboardReplay.result.counterpartyCreated).toBe(true);
              expect(onboardReplay.result.rolePeriodCreated).toBe(true);
              expect(onboardReplay.result.counterpartyRef).toEqual(onboarded.counterpartyRef);

              const add = yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)({
                sourceReference: contactReference,
                partyRef: created.partyRef,
                contactPoint: { type: 'EMAIL', value: 'source-one@example.invalid', preferred: false },
                privacyClassification: 'PERSONAL',
                provenance,
                validFrom: instant,
              });
              const addCommand = {
                ...add,
                acceptedByActionInvocationId: contactInvocation,
                acceptedByPrincipalId: principalId,
                validFrom: instant,
              };
              const point = yield* addContactPointSourceRecord(transaction, scope, addCommand);
              const replay = yield* addContactPointSourceRecord(transaction, scope, {
                ...addCommand,
                acceptedByActionInvocationId: otherInvocation,
              });
              expect(replay.contactPointRef).toEqual(point.contactPointRef);
              expect(replay.revision).toBe(1);
              expect(replay).toMatchObject({ sourceReplayed: true });
              const conflict = yield* addContactPointSourceRecord(transaction, scope, {
                ...addCommand,
                contactPoint: { type: 'EMAIL', value: 'changed@example.invalid', preferred: false },
              }).pipe(Effect.flip);
              expect(conflict).toMatchObject({ reason: 'client_source_effect_identity_conflict' });
              privacyAllowed = false;
              expect(
                yield* recoverPartySourceLifecycleReceipt(transaction, scope, {
                  operation: 'ADD_CONTACT_POINT',
                  payload: add,
                }).pipe(Effect.flip),
              ).toMatchObject({ reason: 'client_source_privacy_denied' });
              privacyAllowed = true;
              expect(
                yield* recoverPartySourceLifecycleReceipt(transaction, scope, {
                  operation: 'ADD_CONTACT_POINT',
                  payload: add,
                }).pipe(
                  Effect.provideService(
                    ConfigProvider.ConfigProvider,
                    ConfigProvider.fromUnknown({ ONTOS_PARTY_CLIENT_SOURCE_BINDINGS: '[]' }),
                  ),
                  Effect.flip,
                ),
              ).toMatchObject({ reason: 'client_source_not_authorized' });
              const recovered = yield* recoverPartySourceLifecycleReceipt(transaction, scope, {
                operation: 'ADD_CONTACT_POINT',
                payload: add,
              });
              assert.isOk(recovered.outcome === 'COMMITTED');
              expect(recovered.actionInvocationId).toBe(contactInvocation);
              expect(recovered.result).toEqual({
                changed: true,
                contactPointRef: point.contactPointRef,
                partyRef: point.partyRef,
                revision: point.revision,
              });

              const otherAdd = {
                ...addCommand,
                sourceReference: { ...contactReference, source: otherSource },
                contactPoint: { type: 'EMAIL' as const, value: 'source-two@example.invalid', preferred: false },
                acceptedByActionInvocationId: otherInvocation,
              };
              const other = yield* addContactPointSourceRecord(transaction, scope, otherAdd);
              expect(other.contactPointRef.resourceId).not.toBe(point.contactPointRef.resourceId);
              const update = yield* Schema.decodeUnknownEffect(UpdateContactPointPayloadSchema)({
                sourceReference: { ...contactReference, occurrenceId: 'contact-update-1' },
                contactPointRef: point.contactPointRef,
                expectedRevision: 1,
                provenance,
                change: { type: 'SET_CHANNEL_PREFERRED', preferred: true },
              });
              const updateCommand = {
                ...update,
                change: { type: 'SET_CHANNEL_PREFERRED' as const, preferred: true },
                acceptedByActionInvocationId: updateInvocation,
                acceptedByPrincipalId: principalId,
              };
              expect(
                yield* updateContactPointSourceRecord(transaction, scope, {
                  ...updateCommand,
                  sourceReference: { ...contactReference, source: otherSource, occurrenceId: 'wrong-owner-update' },
                }).pipe(Effect.flip),
              ).toMatchObject({ reason: 'client_source_exact_contact_target_required' });
              const updated = yield* updateContactPointSourceRecord(transaction, scope, updateCommand);
              expect(updated.revision).toBe(2);
              expect(
                (yield* updateContactPointSourceRecord(transaction, scope, {
                  ...updateCommand,
                  acceptedByActionInvocationId: otherInvocation,
                })).revision,
              ).toBe(2);
              const effectiveEnd = databaseClock.instant;
              const end = yield* Schema.decodeUnknownEffect(EndContactPointPayloadSchema)({
                sourceReference: { ...contactReference, occurrenceId: 'contact-end-1' },
                contactPointRef: point.contactPointRef,
                effectiveEnd,
                reason: 'Explicit source Contact end',
                provenance,
                target: { type: 'WHOLE_CONTACT_POINT' },
              });
              const endCommand = {
                ...end,
                effectiveEnd,
                acceptedByActionInvocationId: endInvocation,
                acceptedByPrincipalId: principalId,
              };
              const ended = yield* endContactPointSourceRecord(transaction, scope, endCommand);
              expect(ended.changed).toBe(true);
              const endedReplay = yield* endContactPointSourceRecord(transaction, scope, {
                ...endCommand,
                acceptedByActionInvocationId: otherInvocation,
              });
              expect(endedReplay.changed).toBe(false);
              expect(endedReplay.contactPoint).not.toHaveProperty('sourceReplayed');
              expect(
                yield* addContactPointSourceRecord(transaction, scope, {
                  ...addCommand,
                  sourceReference: { ...contactReference, occurrenceId: 'resurrect-address' },
                }).pipe(Effect.flip),
              ).toMatchObject({ reason: 'client_source_contact_record_already_bound' });
              const addressReference = {
                source: addressSource,
                recordId: 'address-id-1',
                occurrenceId: 'address-add-1',
              };
              const addressPayload = yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)({
                sourceReference: addressReference,
                partyRef: created.partyRef,
                contactPoint: {
                  type: 'ADDRESS',
                  address: {
                    addressLine1: 'Private fixture address line',
                    city: 'Praha',
                    postalCode: '11000',
                    countryCode: 'CZ',
                  },
                  purposes: [
                    { purpose: 'BILLING', preferred: false },
                    { purpose: 'CORRESPONDENCE', preferred: false },
                  ],
                },
                privacyClassification: 'PERSONAL',
                provenance,
                validFrom: instant,
              });
              const address = yield* addContactPointSourceRecord(transaction, scope, {
                ...addressPayload,
                validFrom: instant,
                acceptedByActionInvocationId: 'ad140000-0000-4000-8000-000000000007',
                acceptedByPrincipalId: principalId,
              });
              expect(address.contactPointRef.resourceId).not.toBe('address-id-1');
              expect(address.partyRef).toEqual(created.partyRef);
              const purposeEndPayload = yield* Schema.decodeUnknownEffect(UpdateContactPointPayloadSchema)({
                sourceReference: { ...addressReference, occurrenceId: 'address-purpose-end-1' },
                contactPointRef: address.contactPointRef,
                expectedRevision: 1,
                provenance,
                change: {
                  type: 'END_ADDRESS_PURPOSE',
                  effectiveEnd,
                  reason: 'Explicit source Billing purpose end',
                  target: { purpose: 'BILLING' },
                },
              });
              const purposeEndCommand = {
                ...purposeEndPayload,
                change: {
                  type: 'END_ADDRESS_PURPOSE' as const,
                  effectiveEnd,
                  reason: 'Explicit source Billing purpose end',
                  target: { purpose: 'BILLING' as const },
                },
                acceptedByActionInvocationId: 'ad140000-0000-4000-8000-000000000008',
                acceptedByPrincipalId: principalId,
              };
              const endedPurpose = yield* updateContactPointSourceRecord(transaction, scope, purposeEndCommand);
              expect(endedPurpose.revision).toBe(2);
              const purposeRecovery = yield* recoverPartySourceLifecycleReceipt(transaction, scope, {
                operation: 'UPDATE_CONTACT_POINT',
                payload: purposeEndPayload,
              });
              expect(purposeRecovery).toMatchObject({ outcome: 'COMMITTED', result: { changed: true, revision: 2 } });
              const repeatedPurposePayload = {
                ...purposeEndPayload,
                sourceReference: { ...addressReference, occurrenceId: 'address-purpose-end-2' },
                expectedRevision: 2,
              };
              const unchangedPurpose = yield* updateContactPointSourceRecord(transaction, scope, {
                ...purposeEndCommand,
                sourceReference: repeatedPurposePayload.sourceReference,
                expectedRevision: 2,
                acceptedByActionInvocationId: 'ad140000-0000-4000-8000-000000000009',
              });
              expect(unchangedPurpose.revision).toBe(2);
              expect(unchangedPurpose).toMatchObject({ sourceUnchanged: true });
              const unchangedRecovery = yield* recoverPartySourceLifecycleReceipt(transaction, scope, {
                operation: 'UPDATE_CONTACT_POINT',
                payload: repeatedPurposePayload,
              });
              expect(unchangedRecovery).toMatchObject({
                outcome: 'COMMITTED',
                result: { changed: false, revision: 2 },
              });
              const receipts = yield* transaction
                .select()
                .from(partySourceEffectReceipts)
                .where(eq(partySourceEffectReceipts.tenantId, tenantId));
              expect(receipts).toHaveLength(8);
              const receiptDocument = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(receipts);
              expect(receiptDocument).not.toContain('source-one@example.invalid');
              expect(receiptDocument).not.toContain('source-two@example.invalid');
              expect(receiptDocument).not.toContain('Internal lifecycle fixture');
              expect(receiptDocument).not.toContain('Private fixture address line');
              const points = yield* transaction
                .select({ revision: partyContactPoints.revision })
                .from(partyContactPoints)
                .where(
                  and(
                    eq(partyContactPoints.tenantId, tenantId),
                    eq(partyContactPoints.contactPointId, point.contactPointRef.resourceId),
                  ),
                );
              expect(points).toEqual([{ revision: 3 }]);
              yield* transaction
                .update(parties)
                .set({ archivedAt: DateTime.toDateUtc(DateTime.makeUnsafe(databaseClock.instant)) })
                .where(and(eq(parties.tenantId, tenantId), eq(parties.partyId, point.partyRef.resourceId)));
              expect(
                yield* recoverPartySourceLifecycleReceipt(transaction, scope, {
                  operation: 'ADD_CONTACT_POINT',
                  payload: add,
                }).pipe(Effect.flip),
              ).toMatchObject({ reason: 'client_source_current_target_required' });
              return yield* Effect.fail('internal_source_lifecycle_rollback' as const);
            }).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, sourceConfig),
              Effect.provideService(PartyClientSourcePrivacy, {
                checkImport: () => Effect.succeed(privacyAllowed ? 'ALLOWED' : 'DENIED'),
              }),
            ),
          )
          .pipe(Effect.result);
        assert.isOk(Result.isFailure(completed));
        expect(completed.failure).toBe('internal_source_lifecycle_rollback');
      }),
  );
});
