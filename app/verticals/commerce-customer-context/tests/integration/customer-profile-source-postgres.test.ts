import { randomUUID } from 'node:crypto';
import { ContextAccessLive, ReadRuntime, runAction } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { EnsureRetailCustomerProfilePayloadSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import { CustomerProfileSourceResponseSchema } from '../../shared/apis/customer-profile-source.ts';
import type { CustomerProfileSourceRequest } from '../../shared/apis/customer-profile-source.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import type { CustomerProfilePartySourceReference } from '../../shared/domain/customer-profile-source.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { customerProfileSourceRead } from '../../src/api/customer-profile-source.read.ts';
import {
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingRejected,
} from '../../src/integrations/source-processing-eligibility.ts';
import { CommerceSourceProfileOwnerProof } from '../../src/integrations/source-profile-owner-proof.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import {
  commerceCustomerContextRelations,
  customerProfileSourceBindings,
  customerProfileSourceReceipts,
  customerProfileSourceRoutes,
  customerProfiles,
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

const partyReferenceKey = (reference: CustomerProfilePartySourceReference) =>
  JSON.stringify([
    reference.source.issuer,
    reference.source.namespace,
    reference.source.recordType,
    reference.source.routeRef,
    reference.recordId,
    reference.occurrenceId,
  ]);

it.live(
  'atomically recovers source Profile effects and pages only current authorized source bindings',
  () =>
    Effect.scoped(
      Effect.gen(function* sourceProfileNative() {
        const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(ultramodernApiMarker.buildMarker, [
          'party-registry',
          'privacy',
        ]);
        const isolated = yield* makeIsolatedNativeDatabaseFixture({
          compositionSnapshot: snapshot,
          mode: 'schema-only',
          purpose: 'implementation-1096-profile-source',
        });
        const adminContext = yield* Layer.build(
          PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
            Layer.provideMerge(Reactivity.layer),
          ),
        );
        const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
          Effect.provide(adminContext),
        );
        const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
        const adminSql = Context.get(adminContext, PgClient.PgClient);
        const [migrationProof] = yield* adminSql<{
          proof_preserved: boolean;
        }>`select position('owner_evidence' in pg_get_functiondef('commerce_customer_context.ensure_source_customer_profile(uuid,uuid,uuid,uuid,timestamptz,jsonb)'::regprocedure))>0 proof_preserved`;
        expect(migrationProof).toEqual({ proof_preserved: true });
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: 'allowed',
            actionExecutor: 'manager-only',
            actionKeys: [
              ensureRetailCustomerProfileAction.descriptor.actionKey,
              createCounterpartyPurchasingProfileAction.descriptor.actionKey,
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
        const partyId = randomUUID();
        const counterpartyId = randomUUID();
        const customerRoleId = randomUUID();
        const counterpartyEffectId = 'profile-effect-3';
        const admittedPartyReferences = new Map<string, string>();
        let privacyDenied = false;
        let profileTargetDenied = false;
        let partyUnavailable = false;
        let privacyChecks = 0;
        let currentAdmissionRevision = 1;
        const currentDecisionId = randomUUID();
        const sourceAdmissionInvocationId = randomUUID();
        const observedPrivacy: { operation: string; targetKind: string | null }[] = [];
        const observedPartyCitations: unknown[] = [];
        const observedPrivacyRequirements = new Set<string>();
        const observedPartyRequirements = new Set<string>();
        // INTERNAL_CONTRACT: Party and Privacy prove their own receivers separately; this fixture
        // provides exact current decisions to exercise Commerce's actual transactional owner boundary.
        const ordinary = Layer.mergeAll(
          Layer.succeed(CommerceSourceProfileOwnerProof, {
            counterparty: (scope, requestedCounterparty, _source, reference, operationRequirementKey) =>
              Effect.sync(() => {
                observedPartyRequirements.add(operationRequirementKey);
                return partyUnavailable ||
                  scope.tenantId !== fixture.tenantId ||
                  requestedCounterparty !== counterpartyId ||
                  admittedPartyReferences.get(partyReferenceKey(reference)) !== partyId
                  ? { outcome: 'INDETERMINATE' as const }
                  : {
                      currentAdmission: {
                        counterpartyRef: {
                          moduleId: 'party.registry',
                          resourceId: counterpartyId,
                          resourceType: 'party.registry.counterparty',
                          tenantId: fixture.tenantId,
                        },
                        counterpartyRevision: 'b'.repeat(64),
                        currentCustomerRoleRef: {
                          moduleId: 'party.registry',
                          resourceId: customerRoleId,
                          resourceType: 'party.registry.counterparty-role-period',
                          tenantId: fixture.tenantId,
                        },
                        currentCustomerRoleRevision: 'c'.repeat(64),
                        legalEntityRef: {
                          moduleId: 'core.identity',
                          resourceId: fixture.legalEntityId,
                          resourceType: 'core.identity.legal-entity',
                          tenantId: fixture.tenantId,
                        },
                        outcome: 'CUSTOMER_CURRENT',
                        partyRef: {
                          moduleId: 'party.registry',
                          resourceId: partyId,
                          resourceType: 'party.registry.party',
                          tenantId: fixture.tenantId,
                        },
                        partyRevision: currentAdmissionRevision,
                        sourceReference: reference,
                      } as const,
                      managedLegalEntityId: fixture.legalEntityId,
                      outcome: 'ELIGIBLE' as const,
                      partyResourceId: partyId,
                      roleResourceId: customerRoleId,
                      roleResourceRevision: '2026-11-07T00:00:00.000Z',
                    };
              }),
            retail: (scope, ref, _source, reference, operationRequirementKey) =>
              Effect.sync(() => {
                observedPartyRequirements.add(operationRequirementKey);
                return partyUnavailable ||
                  scope.tenantId !== fixture.tenantId ||
                  admittedPartyReferences.get(partyReferenceKey(reference)) !== ref.resourceId
                  ? { outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const }
                  : {
                      currentAdmission: {
                        outcome: 'SOURCE_PERSON_CURRENT',
                        partyRef: ref,
                        partyRevision: currentAdmissionRevision,
                        sourceActionInvocationId: sourceAdmissionInvocationId,
                        sourceDecisionRef: {
                          moduleId: 'party.registry',
                          resourceId: currentDecisionId,
                          resourceType: 'party.registry.party-match-decision',
                          tenantId: fixture.tenantId,
                        },
                        sourceReference: reference,
                      } as const,
                      outcome: 'CURRENT_PARTY_RESOLVED' as const,
                      partyResourceId: ref.resourceId,
                      partyResourceRevision: 'internal-party-revision-1',
                    };
              }),
          }),
          Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
            make:
              () =>
              ({ partyResourceId, tenantId }) =>
                tenantId === fixture.tenantId && !partyUnavailable
                  ? Effect.succeed({
                      outcome: 'CURRENT_PARTY_RESOLVED' as const,
                      partyResourceId,
                      partyResourceRevision: 'internal-party-revision-1',
                    })
                  : Effect.succeed({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const }),
          }),
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make: () => () =>
              Effect.succeed(
                partyUnavailable
                  ? { outcome: 'INDETERMINATE' as const }
                  : {
                      managedLegalEntityId: fixture.legalEntityId,
                      outcome: 'ELIGIBLE' as const,
                      partyResourceId: partyId,
                      roleResourceId: customerRoleId,
                      roleResourceRevision: '2026-11-07T00:00:00.000Z',
                    },
              ),
          }),
          Layer.succeed(CommerceSourceProcessingEligibility, {
            check: (scope, input, operationRequirementKey) => {
              observedPrivacyRequirements.add(operationRequirementKey);
              privacyChecks += 1;
              observedPrivacy.push({ operation: input.operation, targetKind: input.target?.kind ?? null });
              if (input.operation === 'PROFILE_CREATE') {
                observedPartyCitations.push(input.partySourceReference);
              }
              return scope.tenantId !== fixture.tenantId ||
                privacyDenied ||
                (profileTargetDenied && input.target?.kind === 'RETAIL_CUSTOMER_PROFILE')
                ? Effect.fail(
                    new CommerceSourceProcessingRejected({
                      code: 'DENIED',
                      reason: 'Internal current protected-material decision',
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
        const now = DateTime.formatIso(yield* DateTime.now);
        const source = {
          effectId: 'profile-effect-1',
          issuer: 'internal-ebs',
          mappingRevision: 'mapping-1',
          namespace: 'customers',
          occurrenceId: 'customer-001-r1',
          order: 1,
          recordId: 'customer-001',
          recordType: 'customer',
          revision: 'r1',
          route: { id: 'source-profiles', revision: 'route-1' },
        };
        const authority = {
          issuer: source.issuer,
          mappingRevision: source.mappingRevision,
          namespace: source.namespace,
          recordType: source.recordType,
          route: source.route,
        };
        const partySourceReference = {
          occurrenceId: 'person-001-r1',
          recordId: 'person-001',
          source: {
            issuer: 'internal-party-source',
            namespace: 'identity',
            recordType: 'person',
            routeRef: 'party-source-route',
          },
        };
        admittedPartyReferences.set(partyReferenceKey(partySourceReference), partyId);
        const payload = yield* Schema.decodeUnknownEffect(EnsureRetailCustomerProfilePayloadSchema)({
          effectiveAt: now,
          partySourceReference,
          source,
          subject: {
            kind: 'RETAIL',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: partyId,
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
        const ensure = (input = payload) =>
          runAction({
            payload: input,
            principal,
            registration: ensureRetailCustomerProfileAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        const read = (input: CustomerProfileSourceRequest) =>
          Context.get(context, ReadRuntime)
            .runRead({ input, principal, registration: customerProfileSourceRead, transport: transport() })
            .pipe(Effect.provideContext(context));
        expect(yield* Effect.flip(ensure())).toMatchObject({ code: 'SOURCE_AUTHORITY_DENIED' });
        expect(
          yield* admin.select().from(customerProfiles).where(eq(customerProfiles.tenantId, fixture.tenantId)),
        ).toHaveLength(0);
        yield* admin.insert(customerProfileSourceRoutes).values({
          active: true,
          issuer: source.issuer,
          legalEntityId: fixture.legalEntityId,
          mappingRevision: source.mappingRevision,
          namespace: source.namespace,
          principalId: fixture.manager.principalId,
          recordType: source.recordType,
          routeId: source.route.id,
          routeRevision: source.route.revision,
          tenantId: fixture.tenantId,
        });
        expect(
          Schema.is(CustomerProfileSourceResponseSchema.members[0])(
            yield* read({ ...authority, mode: 'CURRENT', recordId: source.recordId }),
          ),
        ).toBe(true);
        profileTargetDenied = true;
        const [first, retry] = yield* Effect.all([ensure(), ensure()], { concurrency: 2 });
        const minimal = yield* read({ ...authority, effectId: source.effectId, mode: 'MINIMAL_RECEIPT' });
        expect(minimal).toMatchObject({
          receipt: { intent: payload, result: { outcome: 'PROFILE_CREATED' } },
        });
        expect('current' in minimal).toBe(false);
        currentAdmissionRevision = 2;
        const freshMinimal = yield* read({ ...authority, effectId: source.effectId, mode: 'MINIMAL_RECEIPT' });
        expect(freshMinimal).toMatchObject({
          currentAdmission: {
            partyRevision: 2,
            sourceDecisionRef: { resourceId: currentDecisionId },
            sourceReference: partySourceReference,
          },
        });
        expect(freshMinimal).toMatchObject({ receipt: { result: { revision: 1 } } });
        profileTargetDenied = false;
        expect(first.profileRef).toEqual(retry.profileRef);
        expect(first.outcome).toBe('PROFILE_CREATED');
        expect(retry.outcome).toBe('PROFILE_CREATED');
        expect([first.sourceEffect?.replayed, retry.sourceEffect?.replayed].filter(Boolean)).toHaveLength(1);
        const original = first.sourceEffect?.replayed === false ? first : retry;
        expect(observedPrivacy).toContainEqual({ operation: 'PROFILE_CREATE', targetKind: 'PARTY' });
        expect(observedPartyCitations).toContainEqual(partySourceReference);

        const receipt = yield* read({ ...authority, effectId: source.effectId, mode: 'RECEIPT' });
        expect(receipt).toMatchObject({
          current: {
            partyRef: payload.subject.partyRef,
            profile: { profileRef: { ...original.profileRef, kind: 'RETAIL' } },
          },
          receipt: { intent: payload, result: original },
        });
        const revisedPartyReference = { ...partySourceReference, occurrenceId: 'another-original-party-admission' };
        admittedPartyReferences.set(partyReferenceKey(revisedPartyReference), partyId);
        yield* ensure({
          ...payload,
          partySourceReference: revisedPartyReference,
          source: {
            ...source,
            effectId: 'profile-effect-4',
            occurrenceId: 'customer-001-r2',
            order: 2,
            revision: 'r2',
          },
        });
        expect(yield* read({ ...authority, mode: 'CURRENT', recordId: source.recordId })).toMatchObject({
          item: { icoAuthority: 'PERSONAL', partySourceReference, source: { order: 2, revision: 'r2' } },
        });
        expect(
          yield* Effect.flip(
            ensure({ ...payload, source: { ...source, effectId: 'late-r1', occurrenceId: 'late-r1' } }),
          ),
        ).toMatchObject({ code: 'SOURCE_STALE' });
        expect((yield* ensure()).sourceEffect?.replayed).toBe(true);
        expect(yield* Effect.flip(ensure({ ...payload, trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE' }))).toMatchObject({
          code: 'SOURCE_CONFLICT',
        });
        const second = yield* ensure({
          ...payload,
          source: {
            ...source,
            effectId: 'profile-effect-2',
            occurrenceId: 'customer-002-r1',
            recordId: 'customer-002',
          },
        });
        expect(second.outcome).toBe('PROFILE_ALREADY_EXISTS_ACTIVE');
        expect(second.profileRef).toEqual(original.profileRef);
        const page = yield* read({ ...authority, cursor: null, limit: 1, mode: 'LIST' });
        expect(page).toMatchObject({
          items: [{ icoAuthority: 'PERSONAL', source: { recordId: 'customer-001' } }],
          nextCursor: 'customer-001',
        });
        expect(yield* read({ ...authority, cursor: 'customer-001', limit: 1, mode: 'LIST' })).toMatchObject({
          items: [{ icoAuthority: 'PERSONAL', source: { recordId: 'customer-002' } }],
          nextCursor: null,
        });
        const beforeRollbackProfiles = yield* admin
          .select()
          .from(customerProfiles)
          .where(eq(customerProfiles.tenantId, fixture.tenantId));
        profileTargetDenied = true;
        expect(
          yield* Effect.flip(
            ensure({
              ...payload,
              source: { ...source, effectId: 'rollback-effect', recordId: 'rollback-customer' },
            }),
          ),
        ).toMatchObject({ code: 'PRIVACY_DENIED' });
        profileTargetDenied = false;
        expect(
          yield* admin.select().from(customerProfiles).where(eq(customerProfiles.tenantId, fixture.tenantId)),
        ).toEqual(beforeRollbackProfiles);
        expect(
          Schema.is(CustomerProfileSourceResponseSchema.members[0])(
            yield* read({ ...authority, mode: 'CURRENT', recordId: 'rollback-customer' }),
          ),
        ).toBe(true);
        const cp = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)({
          effectiveAt: now,
          partySourceReference,
          source: {
            ...source,
            effectId: counterpartyEffectId,
            occurrenceId: 'customer-003-r1',
            recordId: 'customer-003',
          },
          subject: {
            counterpartyRef: {
              moduleId: 'party.registry',
              resourceId: counterpartyId,
              resourceType: 'party.registry.counterparty',
              tenantId: fixture.tenantId,
            },
            kind: 'COUNTERPARTY',
          },
          trigger: 'AUTHORIZED_ONBOARDING',
        });
        const counterparty = () =>
          runAction({
            payload: cp,
            principal,
            registration: createCounterpartyPurchasingProfileAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        const createdCounterparty = yield* counterparty();
        expect(createdCounterparty.outcome).toBe('PROFILE_CREATED');
        const counterpartyReceipt = yield* read({ ...authority, effectId: counterpartyEffectId, mode: 'RECEIPT' });
        expect(counterpartyReceipt).toMatchObject({
          currentAdmission: {
            counterpartyRef: cp.subject.counterpartyRef,
            outcome: 'CUSTOMER_CURRENT',
            partyRevision: 2,
            sourceReference: partySourceReference,
          },
        });
        expect((yield* counterparty()).sourceEffect?.replayed).toBe(true);
        expect(yield* read({ ...authority, mode: 'CURRENT', recordId: 'customer-003' })).toMatchObject({
          item: {
            icoAuthority: 'PERSONAL',
            partyRef: payload.subject.partyRef,
            profile: { profileRef: { ...createdCounterparty.profileRef, kind: 'COUNTERPARTY' } },
          },
        });
        const callsBefore = privacyChecks;
        privacyDenied = true;
        expect(
          yield* Effect.flip(read({ ...authority, effectId: source.effectId, mode: 'MINIMAL_RECEIPT' })),
        ).toMatchObject({
          code: 'read_handler_unavailable',
        });
        expect(yield* Effect.flip(read({ ...authority, effectId: source.effectId, mode: 'RECEIPT' }))).toMatchObject({
          code: 'read_handler_unavailable',
        });
        expect(yield* Effect.flip(ensure())).toMatchObject({ code: 'PRIVACY_DENIED' });
        expect(privacyChecks).toBeGreaterThan(callsBefore);
        expect(observedPrivacyRequirements).toEqual(
          new Set([
            'commerce.customer-context.requirement.create-counterparty-profile-source-privacy',
            'commerce.customer-context.requirement.customer-profile-source-privacy',
            'commerce.customer-context.requirement.ensure-retail-profile-source-privacy',
          ]),
        );
        expect(observedPartyRequirements).toEqual(
          new Set([
            'commerce.customer-context.requirement.create-counterparty-profile-source-role',
            'commerce.customer-context.requirement.create-counterparty-profile-source-person',
            'commerce.customer-context.requirement.customer-profile-source-counterparty',
            'commerce.customer-context.requirement.customer-profile-source-counterparty-person',
            'commerce.customer-context.requirement.customer-profile-source-party',
            'commerce.customer-context.requirement.ensure-retail-profile-source-person',
          ]),
        );
        privacyDenied = false;
        partyUnavailable = true;
        expect(yield* Effect.flip(read({ ...authority, cursor: null, limit: 10, mode: 'LIST' }))).toMatchObject({
          code: 'read_handler_unavailable',
        });
        partyUnavailable = false;
        yield* admin
          .update(customerProfileSourceRoutes)
          .set({ active: false })
          .where(eq(customerProfileSourceRoutes.tenantId, fixture.tenantId));
        expect(yield* Effect.flip(read({ ...authority, effectId: source.effectId, mode: 'RECEIPT' }))).toMatchObject({
          code: 'read_permission_denied',
        });
        const [bindings, receipts] = yield* Effect.all([
          admin
            .select()
            .from(customerProfileSourceBindings)
            .where(eq(customerProfileSourceBindings.tenantId, fixture.tenantId)),
          admin
            .select()
            .from(customerProfileSourceReceipts)
            .where(eq(customerProfileSourceReceipts.tenantId, fixture.tenantId)),
        ]);
        expect(bindings).toHaveLength(3);
        expect(receipts).toHaveLength(4);
        expect(receipts.every((entry) => entry.ownerEvidence !== null)).toBe(true);
        const durableEvidence = yield* fixture.evidence(coreEvidenceExecutor);
        expect(
          durableEvidence.events.filter(
            (event) => event.eventType === 'commerce.customer-context.retail-customer-profile-created.v1',
          ),
        ).toHaveLength(1);
        const [evidence] = yield* adminSql<{
          helper: boolean;
          raw: boolean;
        }>`select has_table_privilege('ontos_runtime','commerce_customer_context.customer_profile_source_receipts','SELECT') raw,has_function_privilege('ontos_runtime','commerce_customer_context.customer_profile_source_item(uuid,uuid,jsonb)','EXECUTE') helper`;
        expect(evidence).toEqual({ helper: false, raw: false });
      }),
    ).pipe(Effect.provide(platform)),
  { timeout: 180_000 },
);
