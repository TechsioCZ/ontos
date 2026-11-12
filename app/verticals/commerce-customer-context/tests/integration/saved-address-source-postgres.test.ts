import { randomUUID } from 'node:crypto';
import { ContextAccessLive, ReadRuntime, runAction } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { EnsureRetailCustomerProfilePayloadSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import {
  AddSavedAddressPayloadSchema,
  UpdateSavedAddressPayloadSchema,
  RemoveSavedAddressPayloadSchema,
} from '../../shared/domain/address-actions.ts';
import { SavedAddressSourceRejected } from '../../shared/domain/saved-address-source.ts';
import { SavedAddressSourceReceiptRequestSchema } from '../../shared/apis/saved-address-source-receipt.ts';
import type { SavedAddressSourceReceiptRequest } from '../../shared/apis/saved-address-source-receipt.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import { addSavedAddressAction } from '../../src/actions/add-saved-address.action.ts';
import { updateSavedAddressAction } from '../../src/actions/update-saved-address.action.ts';
import { removeSavedAddressAction } from '../../src/actions/remove-saved-address.action.ts';
import { savedAddressSourceReceiptRead } from '../../src/api/saved-address-source-receipt.read.ts';
import {
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingRejected,
} from '../../src/integrations/source-processing-eligibility.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import {
  commerceCustomerContextRelations,
  savedAddressSourceRoutes,
  savedAddressSourceReceipts,
  savedAddressSourceBindings,
} from '../../src/database/schema.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const platform = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const transport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'commerce.customer-context',
});
it.live(
  'applies qualified native address effects and recovers only immutable minimal original evidence',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeSourceAddresses() {
        const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, [
          'party-registry',
          'privacy',
        ]);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-address-source',
        });
        const adminContext = yield* Layer.build(
          PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        );
        const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
          Effect.provide(adminContext),
        );
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: 'allowed',
            actionExecutor: 'manager-only',
            actionKeys: [
              ensureRetailCustomerProfileAction.descriptor.actionKey,
              createCounterpartyPurchasingProfileAction.descriptor.actionKey,
              addSavedAddressAction.descriptor.actionKey,
              updateSavedAddressAction.descriptor.actionKey,
              removeSavedAddressAction.descriptor.actionKey,
            ],
            adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
            allowedAudiences: ['commerce-customer-context'],
            applicationComposition: { load: Effect.succeed(snapshot) },
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            compositionRevision: snapshot.composition.revision,
            expectedDeployment: ultramodernApiMarker,
            moduleKeys: ['commerce.customer-context', 'party.registry', 'privacy.core'],
            ownerRegistration: commerceCustomerContextRegistration,
            runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
          }),
          (resource) => resource.close().pipe(Effect.orDie),
        );
        const fixtureCounterpartyId = randomUUID();
        const fixturePartyId = randomUUID();
        const fixtureCustomerRoleId = randomUUID();
        let privacyDenied = false;
        let privacyChecks = 0;
        // INTERNAL_CONTRACT only: exact Party/Privacy leaf decisions exercise Commerce's actual registered owner receiver.
        const ordinary = Layer.mergeAll(
          Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
            make:
              () =>
              ({ partyResourceId }) =>
                Effect.succeed({
                  outcome: 'CURRENT_PARTY_RESOLVED' as const,
                  partyResourceId,
                  partyResourceRevision: 'fixture-party-1',
                }),
          }),
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make:
              () =>
              ({ counterpartyResourceId, tenantId }) =>
                Effect.succeed(
                  counterpartyResourceId === fixtureCounterpartyId && tenantId === fixture.tenantId
                    ? {
                        managedLegalEntityId: fixture.legalEntityId,
                        outcome: 'ELIGIBLE' as const,
                        partyResourceId: fixturePartyId,
                        roleResourceId: fixtureCustomerRoleId,
                        roleResourceRevision: '2026-11-07T00:00:00.000Z',
                      }
                    : { outcome: 'INDETERMINATE' as const },
                ),
          }),
          Layer.succeed(CommerceSourceProcessingEligibility, {
            check: (_scope, input) => {
              privacyChecks += 1;
              expect(
                new Set(['billing-address-17', 'counterparty-billing-address-17']).has(input.source?.recordId ?? ''),
              ).toBe(true);
              return privacyDenied
                ? Effect.fail(
                    new CommerceSourceProcessingRejected({
                      code: 'DENIED',
                      reason: 'Current internal anti-resurrection decision',
                    }),
                  )
                : Effect.void;
            },
          }),
          profileReactivationEligibilityEvaluatorFactoryLive,
          partyRegistryGuestResolverFactoryLive,
        ).pipe(Layer.provideMerge(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
        const context = yield* Layer.build(ordinary.pipe(Layer.provideMerge(fixture.layer)));
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        const profilePayload = yield* Schema.decodeUnknownEffect(EnsureRetailCustomerProfilePayloadSchema)({
          effectiveAt: '2026-11-07T00:00:00.000Z',
          subject: {
            kind: 'RETAIL',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: randomUUID(),
              resourceType: 'party.registry.party',
              tenantId: fixture.tenantId,
            },
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: fixture.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: fixture.tenantId,
            },
          },
          trigger: 'AUTHORIZED_ONBOARDING',
        });
        const profileAck = yield* runAction({
          payload: profilePayload,
          principal,
          registration: ensureRetailCustomerProfileAction,
          transport: transport(),
        }).pipe(Effect.provideContext(context));
        const profile = { kind: 'RETAIL' as const, profileRef: profileAck.profileRef };
        const source = {
          effectId: 'address-add-1',
          identity: {
            issuer: 'internal-ebs',
            namespace: 'addresses',
            occurrenceId: 'billing-address-17-r1',
            recordId: 'billing-address-17',
            recordType: 'postal-address',
            routeRef: 'internal-address-route',
          },
          mappingRevision: 'mapping-1',
          order: 1,
          purposes: ['BILLING'] as const,
          revision: 'r1',
          routeRevision: 'route-1',
        };
        yield* admin.insert(savedAddressSourceRoutes).values({
          active: true,
          issuer: source.identity.issuer,
          legalEntityId: fixture.legalEntityId,
          mappingRevision: source.mappingRevision,
          namespace: source.identity.namespace,
          principalId: fixture.manager.principalId,
          recordType: source.identity.recordType,
          routeRef: source.identity.routeRef,
          routeRevision: source.routeRevision,
          tenantId: fixture.tenantId,
        });
        const addPayload = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)({
          label: 'Internal billing fixture',
          origin: {
            kind: 'COMMERCE_ONLY',
            postalAddress: {
              addressLine1: '17 Internal Street',
              city: 'Prague',
              countryCode: 'CZ',
              postalCode: '11000',
            },
          },
          profile,
          purposes: ['BILLING'],
          reason: 'Apply explicit qualified billing address',
          source,
        });
        const add = (payload = addPayload, key = randomUUID()) =>
          runAction({
            payload,
            principal,
            registration: addSavedAddressAction,
            transport: { ...transport(), idempotencyKey: key },
          }).pipe(Effect.provideContext(context));
        const { source: declaredSource, ...humanPayload } = addPayload;
        expect(declaredSource).toEqual(source);
        const humanAdd = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)({
          ...humanPayload,
          origin: {
            kind: 'COMMERCE_ONLY',
            postalAddress: {
              addressLine1: '88 Human Fixture Street',
              city: 'Prague',
              countryCode: 'CZ',
              postalCode: '11000',
            },
          },
        });
        const beforeHuman = privacyChecks;
        expect((yield* add(humanAdd)).outcome).toBe('ADDED');
        expect(privacyChecks).toBe(beforeHuman);
        const key = randomUUID();
        const added = yield* add(addPayload, key);
        expect(added.outcome).toBe('ADDED');
        expect(yield* Effect.flip(add(addPayload, key))).toMatchObject({ code: 'action_already_committed' });
        expect(yield* Effect.flip(add())).toBeInstanceOf(SavedAddressSourceRejected);
        const changedRetry = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)({
          ...addPayload,
          label: 'Different source retry intent',
        });
        expect(yield* Effect.flip(add(changedRetry))).toMatchObject({ code: 'saved_address_source_conflict' });

        const original = yield* admin
          .select()
          .from(savedAddressSourceReceipts)
          .pipe(
            Effect.flatMap(([row]) =>
              row === undefined ? Effect.die('Missing immutable native source receipt') : Effect.succeed(row),
            ),
          );
        const read = (input: SavedAddressSourceReceiptRequest) =>
          Context.get(context, ReadRuntime)
            .runRead({
              input,
              principal,
              registration: savedAddressSourceReceiptRead,
              transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
            })
            .pipe(Effect.provideContext(context));
        const receiptInput = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          actionInvocationId: original.actionInvocationId,
          actionKey: original.actionKey,
          mode: 'RECEIPT',
          profile,
          requestHash: original.requestHash,
          source,
        });
        const recovered = yield* read(receiptInput);
        expect(
          Match.value(recovered).pipe(
            Match.tag('RECEIPT', ({ receipt }) => {
              expect(receipt).toMatchObject({
                operation: 'ADD',
                outcome: 'ADDED',
                revision: 1,
                savedAddressRef: added.address.savedAddressRef,
              });
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const currentInput = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          mode: 'CURRENT',
          profile,
          source,
        });
        expect(
          Match.value(yield* read(currentInput)).pipe(
            Match.tag('CURRENT', (value) => {
              expect(value.savedAddressRef).toEqual(added.address.savedAddressRef);
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const forgedRetailAsCounterparty = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          ...currentInput,
          profile: {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: fixtureCounterpartyId,
              resourceType: 'party.registry.counterparty',
              tenantId: fixture.tenantId,
            },
            kind: 'COUNTERPARTY',
            profileRef: {
              ...profile.profileRef,
              resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
            },
          },
        });
        expect(
          Match.value(yield* read(forgedRetailAsCounterparty)).pipe(
            Match.tag('ABSENT', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const updateSource = {
          ...source,
          effectId: 'address-update-2',
          identity: { ...source.identity, occurrenceId: 'billing-address-17-r2' },
          nativeAddressId: added.address.savedAddressRef.resourceId,
          order: 2,
          revision: 'r2',
        };
        const updatePayload = yield* Schema.decodeUnknownEffect(UpdateSavedAddressPayloadSchema)({
          expectedRevision: 1,
          label: 'Corrected internal billing fixture',
          profile,
          reason: 'Apply qualified label revision2',
          savedAddressRef: added.address.savedAddressRef,
          source: updateSource,
        });
        const updated = yield* runAction({
          payload: updatePayload,
          principal,
          registration: updateSavedAddressAction,
          transport: transport(),
        }).pipe(Effect.provideContext(context));
        expect(updated.outcome).toBe('UPDATED');
        expect(updated.address.revision).toBe(2);
        expect(yield* read(receiptInput)).toEqual(recovered);
        const stale = yield* Effect.flip(
          runAction({
            payload: {
              ...updatePayload,
              source: { ...updateSource, effectId: 'stale-address-effect', order: 1, revision: 'stale' },
            },
            principal,
            registration: updateSavedAddressAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context)),
        );
        expect(stale).toMatchObject({ code: 'saved_address_source_stale' });
        const removePayload = yield* Schema.decodeUnknownEffect(RemoveSavedAddressPayloadSchema)({
          expectedRevision: 2,
          profile,
          reason: 'Remove explicit internal address',
          savedAddressRef: added.address.savedAddressRef,
          source: {
            ...updateSource,
            effectId: 'address-remove-3',
            identity: { ...source.identity, occurrenceId: 'billing-address-17-r3' },
            order: 3,
            revision: 'r3',
          },
        });
        const removed = yield* runAction({
          payload: removePayload,
          principal,
          registration: removeSavedAddressAction,
          transport: transport(),
        }).pipe(Effect.provideContext(context));
        expect(removed.outcome).toBe('REMOVED');
        expect(removed.address.revision).toBe(3);
        expect(
          Match.value(yield* read(currentInput)).pipe(
            Match.tag('CURRENT', (value) => {
              expect(value.lifecycle).toBe('REMOVED');
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(yield* read(receiptInput)).toEqual(recovered);
        const beforeUnknown = privacyChecks;
        expect(
          Match.value(
            yield* read(
              yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
                ...receiptInput,
                actionInvocationId: randomUUID(),
              }),
            ),
          ).pipe(
            Match.tag('INDETERMINATE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(privacyChecks).toBe(beforeUnknown);
        expect(
          Match.value(
            yield* read(
              yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
                ...receiptInput,
                requestHash: 'b'.repeat(64),
              }),
            ),
          ).pipe(
            Match.tag('INDETERMINATE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const beforeWrongProfile = privacyChecks;
        const wrongProfile = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          ...receiptInput,
          profile: { ...profile, profileRef: { ...profile.profileRef, resourceId: randomUUID() } },
        });
        expect(
          Match.value(yield* read(wrongProfile)).pipe(
            Match.tag('INDETERMINATE', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(privacyChecks).toBe(beforeWrongProfile);
        privacyDenied = true;
        expect(yield* Effect.flip(read(receiptInput))).toMatchObject({ code: 'read_handler_unavailable' });
        privacyDenied = false;
        const receipts = yield* admin.select().from(savedAddressSourceReceipts);
        expect(receipts).toHaveLength(3);
        for (const row of receipts) {
          expect(JSON.stringify(row)).not.toContain('17 Internal Street');
          expect(JSON.stringify(row)).not.toContain('billing fixture');
        }
        const bindings = yield* admin.select().from(savedAddressSourceBindings);
        expect(bindings).toHaveLength(1);
        expect(bindings[0]?.sourceOrder).toBe(3);
        const counterpartyRef = {
          moduleId: 'party.registry' as const,
          resourceId: fixtureCounterpartyId,
          resourceType: 'party.registry.counterparty' as const,
          tenantId: fixture.tenantId,
        };
        const counterpartyPayload = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)(
          {
            effectiveAt: '2026-11-07T00:00:00.000Z',
            subject: {
              counterpartyRef,
              kind: 'COUNTERPARTY',
              sellingLegalEntityRef: profilePayload.subject.sellingLegalEntityRef,
            },
            trigger: 'AUTHORIZED_ONBOARDING',
          },
        );
        const counterpartyAck = yield* runAction({
          payload: counterpartyPayload,
          principal,
          registration: createCounterpartyPurchasingProfileAction,
          transport: transport(),
        }).pipe(Effect.provideContext(context));
        const counterpartyProfile = {
          counterpartyRef,
          kind: 'COUNTERPARTY' as const,
          profileRef: counterpartyAck.profileRef,
        };
        const counterpartySource = {
          ...source,
          effectId: 'counterparty-address-add-1',
          identity: {
            ...source.identity,
            occurrenceId: 'counterparty-billing-address-17-r1',
            recordId: 'counterparty-billing-address-17',
          },
        };
        const counterpartyAddress = yield* add(
          yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)({
            ...addPayload,
            origin: {
              kind: 'COMMERCE_ONLY',
              postalAddress: {
                addressLine1: '23 Counterparty Fixture Street',
                city: 'Prague',
                countryCode: 'CZ',
                postalCode: '11000',
              },
            },
            profile: counterpartyProfile,
            source: counterpartySource,
          }),
        );
        const counterpartyCurrent = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          mode: 'CURRENT',
          profile: counterpartyProfile,
          source: counterpartySource,
        });
        expect(
          Match.value(yield* read(counterpartyCurrent)).pipe(
            Match.tag('CURRENT', (value) => {
              expect(value.profile).toEqual(counterpartyProfile);
              expect(value.savedAddressRef).toEqual(counterpartyAddress.address.savedAddressRef);
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const wrongCounterpartySubject = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          ...counterpartyCurrent,
          profile: { ...counterpartyProfile, counterpartyRef: { ...counterpartyRef, resourceId: randomUUID() } },
        });
        expect(
          Match.value(yield* read(wrongCounterpartySubject)).pipe(
            Match.tag('ABSENT', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const forgedCounterpartyAsRetail = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
          ...counterpartyCurrent,
          profile: {
            kind: 'RETAIL',
            profileRef: {
              ...counterpartyAck.profileRef,
              resourceType: 'commerce.customer-context.retail-customer-profile',
            },
          },
        });
        expect(
          Match.value(yield* read(forgedCounterpartyAsRetail)).pipe(
            Match.tag('ABSENT', () => true),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        yield* admin
          .update(savedAddressSourceRoutes)
          .set({ active: false })
          .where(eq(savedAddressSourceRoutes.routeRef, source.identity.routeRef));
        expect(yield* Effect.flip(read(receiptInput))).toMatchObject({ code: 'read_permission_denied' });
      }),
    ).pipe(Effect.provide(platform)),
  180_000,
);
