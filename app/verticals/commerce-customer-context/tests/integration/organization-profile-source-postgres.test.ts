import { randomUUID } from 'node:crypto';
import { ContextAccessLive, ReadRuntime, runAction } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { OrganizationBusinessApplicabilityCurrentSchema } from '@app/privacy/api/organization-business-applicability';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import type { CustomerProfileSourceRequest } from '../../shared/apis/customer-profile-source.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { customerProfileSourceRead } from '../../src/api/customer-profile-source.read.ts';
import { CommerceOrganizationBusinessEligibility } from '../../src/integrations/organization-business-eligibility.ts';
import { validateOrganizationBusinessDecision } from '../../src/integrations/organization-business-decision.ts';
import { CommerceSourceProfileOwnerProof } from '../../src/integrations/source-profile-owner-proof.ts';
import {
  CommerceSourceProcessingEligibility,
  CommerceSourceProcessingRejected,
} from '../../src/integrations/source-processing-eligibility.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import {
  commerceCustomerContextRelations,
  customerProfileSourceRoutes,
  customerProfileSourceReceipts,
  customerProfileSourceBindings,
  customerProfiles,
} from '../../src/database/schema.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { observedEligibleCounterpartyRole } from '../support/observed-counterparty-role.ts';

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
  'consumes current Organization CUSTOMER proof for source creation and actor-free exact original recovery',
  () =>
    Effect.scoped(
      Effect.gen(function* organizationSourceOwner() {
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
        const fixture = yield* Effect.acquireRelease(
          makeLiveOperationFixture({
            access: 'allowed',
            actionExecutor: 'manager-only',
            actionKeys: [createCounterpartyPurchasingProfileAction.descriptor.actionKey],
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
        const partyRef = {
          moduleId: 'party.registry' as const,
          resourceId: randomUUID(),
          resourceType: 'party.registry.party' as const,
          tenantId: fixture.tenantId,
        };
        const counterpartyRef = {
          moduleId: 'party.registry' as const,
          resourceId: randomUUID(),
          resourceType: 'party.registry.counterparty' as const,
          tenantId: fixture.tenantId,
        };
        const roleRef = {
          moduleId: 'party.registry',
          resourceId: randomUUID(),
          resourceType: 'party.registry.counterparty-role-period',
          tenantId: fixture.tenantId,
        };
        const source = {
          effectId: 'organization-create-1',
          issuer: 'internal-org-source',
          mappingRevision: 'mapping-1',
          namespace: 'company-customers',
          occurrenceId: 'company-17-r1',
          order: 1,
          recordId: 'company-17',
          recordType: 'customer',
          revision: '1',
          route: { id: 'organization-profile-route', revision: '1' },
        };
        const partySourceReference = {
          occurrenceId: 'organization-17-r1',
          recordId: 'organization-17',
          source: {
            issuer: 'independent-party-source',
            namespace: 'organizations',
            recordType: 'company',
            routeRef: 'organization-party-route',
          },
        };
        const organization = {
          partyRef,
          partyRevision: 1,
          sourceCitation: {
            originalOccurrenceId: partySourceReference.occurrenceId,
            sourceActionInvocationId: randomUUID(),
            sourceDecisionRef: {
              moduleId: 'party.registry',
              resourceId: randomUUID(),
              resourceType: 'party.registry.party-match-decision',
              tenantId: fixture.tenantId,
            },
          },
          typeAssertionId: randomUUID(),
          typeAssertionRevision: 'a'.repeat(64),
          typeRecordedAt: '2025-01-01T00:00:00.000Z',
          typeValidFrom: '2025-01-01T00:00:00.000Z',
          typeValidTo: null,
        };
        const legalEntityRef = {
          moduleId: 'core.identity',
          resourceId: fixture.legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: fixture.tenantId,
        };
        let personalCalls = 0;
        let deny = false;
        let denyWrite = false;
        const operations: string[] = [];
        // INTERNAL_OWNER_ONLY: current Organization/CUSTOMER/Privacy proof is a typed service seam.
        // Native Commerce effects, source bindings, and original receipts below use real registered Core and PostgreSQL.
        const ordinary = Layer.mergeAll(
          Layer.succeed(CommerceSourceProfileOwnerProof, {
            counterparty: () => {
              personalCalls += 1;
              return Effect.succeed({ outcome: 'INELIGIBLE' as const });
            },
            retail: () => {
              personalCalls += 1;
              return Effect.succeed({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const });
            },
          }),
          Layer.succeed(CommerceSourceProcessingEligibility, {
            check: () => {
              personalCalls += 1;
              return Effect.fail(
                new CommerceSourceProcessingRejected({
                  code: 'DENIED',
                  reason: 'Organization fields cannot borrow the personal fixture authority',
                }),
              );
            },
          }),
          Layer.succeed(CommerceOrganizationBusinessEligibility, {
            check: (scope, input) =>
              Effect.gen(function* currentOrganizationDecision() {
                operations.push(input.operation);
                if (deny || (denyWrite && input.operation === 'customer-profile-source.write')) {
                  return yield* new CommerceSourceProcessingRejected({
                    code: 'DENIED',
                    reason: 'Internal current Organization business decision denied',
                  });
                }
                const base = {
                  allowedFields: input.fields,
                  applicabilityDecisionRef: 'internal-owner-only-current-org',
                  authorityIncarnation: 'internal-owner-only',
                  authorityRevision: '1',
                  classification: 'CANONICAL_ORGANIZATION',
                  consumerModuleId: 'commerce.customer-context',
                  evaluatedAt: '2026-11-07T00:00:00.000Z',
                  evidenceRefs: ['internal-owner-only-org-role-source-proof'],
                  holdBehavior: 'NO_ACTIVE_SCOPE_HOLD',
                  inputDigest: input.inputDigest,
                  kind: 'ORGANIZATION_BUSINESS_ONLY',
                  operation: input.operation,
                  outcome: 'NOT_APPLICABLE',
                  policyRevisions: [],
                  projectionVersion: input.projectionVersion,
                };
                const customer = {
                  ...organization,
                  counterpartyRef,
                  counterpartyRevision: 'b'.repeat(64),
                  currentCustomerRoleRef: roleRef,
                  currentCustomerRoleRevision: 'c'.repeat(64),
                  legalEntityRef,
                  outcome: 'CURRENT_ORGANIZATION_CUSTOMER',
                };
                const proof = Match.value(input).pipe(
                  Match.when({ kind: 'COUNTERPARTY_CUSTOMER' }, () => ({
                    kind: 'COUNTERPARTY_CUSTOMER' as const,
                    organization: customer,
                  })),
                  Match.when({ kind: 'COUNTERPARTY_PROFILE' }, (profileInput) => ({
                    kind: 'COUNTERPARTY_PROFILE' as const,
                    organization: customer,
                    profile: {
                      _tag: 'CURRENT',
                      counterpartyRef,
                      counterpartyRevision: 'b'.repeat(64),
                      currentCustomerRoleRef: roleRef,
                      currentCustomerRoleRevision: 'c'.repeat(64),
                      legalEntityRef,
                      partyRef,
                      partyRevision: 1,
                      profileRef: profileInput.profileRef,
                      profileRevision: 1,
                    },
                  })),
                  Match.orElse(() => null),
                );
                const response = yield* Schema.decodeUnknownEffect(OrganizationBusinessApplicabilityCurrentSchema)({
                  ...base,
                  liveProof: proof,
                }).pipe(Effect.orDie);
                return yield* validateOrganizationBusinessDecision(scope, input, response);
              }),
          }),
          Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
            make:
              () =>
              ({ counterpartyResourceId, tenantId }) =>
                counterpartyResourceId === counterpartyRef.resourceId && tenantId === fixture.tenantId
                  ? observedEligibleCounterpartyRole({
                      managedLegalEntityId: fixture.legalEntityId,
                      roleResourceId: roleRef.resourceId,
                      roleResourceRevision: '2026-11-07T00:00:00.000Z',
                    })
                  : Effect.succeed({ outcome: 'INDETERMINATE' as const }),
          }),
          Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
            make: () => () => Effect.succeed({ outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const }),
          }),
          profileReactivationEligibilityEvaluatorFactoryLive,
          partyRegistryGuestResolverFactoryLive,
        ).pipe(Layer.provideMerge(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
        const context = yield* Layer.build(ordinary.pipe(Layer.provideMerge(fixture.layer)));
        const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
        yield* admin.insert(customerProfileSourceRoutes).values({
          active: true,
          issuer: source.issuer,
          legalEntityId: fixture.legalEntityId,
          mappingRevision: source.mappingRevision,
          namespace: source.namespace,
          principalId: principal.principalId,
          recordType: source.recordType,
          routeId: source.route.id,
          routeRevision: source.route.revision,
          tenantId: fixture.tenantId,
        });
        const payload = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)({
          effectiveAt: '2025-01-01T00:00:00.000Z',
          partySourceReference,
          source,
          subject: { counterpartyRef, kind: 'COUNTERPARTY', sellingLegalEntityRef: legalEntityRef },
          trigger: 'AUTHORIZED_ONBOARDING',
        });
        const create = (input = payload) =>
          runAction({
            payload: input,
            principal,
            registration: createCounterpartyPurchasingProfileAction,
            transport: transport(),
          }).pipe(Effect.provideContext(context));
        const read = (input: CustomerProfileSourceRequest) =>
          Context.get(context, ReadRuntime)
            .runRead({
              input,
              principal,
              registration: customerProfileSourceRead,
              transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
            })
            .pipe(Effect.provideContext(context));
        const created = yield* create();
        expect(created.outcome).toBe('PROFILE_CREATED');
        expect(personalCalls).toBe(0);
        expect(operations).toEqual(['COUNTERPARTY_PROFILE_CREATE']);
        const authority = {
          issuer: source.issuer,
          mappingRevision: source.mappingRevision,
          namespace: source.namespace,
          recordType: source.recordType,
          route: source.route,
        };
        const original = yield* read({ ...authority, effectId: source.effectId, mode: 'ORG_RECEIPT' });
        expect(
          Match.value(original).pipe(
            Match.tag('ORG_RECEIPT', (value) => {
              expect(value.receipt.result.profileRef).toEqual(created.profileRef);
              expect(JSON.stringify(value)).not.toContain('actorPrincipalId');
              expect(JSON.stringify(value)).not.toContain('sellingLegalEntityRef');
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        const current = yield* read({ ...authority, mode: 'CURRENT', recordId: source.recordId });
        expect(
          Match.value(current).pipe(
            Match.tag('CURRENT', (value) => {
              expect(value.item.profile.profileRef.kind).toBe('COUNTERPARTY');
              expect(value.item.icoAuthority).toBe('ORGANIZATION');
              expect(JSON.stringify(value)).not.toContain('sellingLegalEntityRef');
              return true;
            }),
            Match.orElse(() => false),
          ),
        ).toBe(true);
        expect(personalCalls).toBe(0);
        const update = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)({
          ...payload,
          source: {
            ...source,
            effectId: 'organization-update-2',
            occurrenceId: 'company-17-r2',
            order: 2,
            revision: '2',
          },
        });
        expect((yield* create(update)).outcome).toBe('PROFILE_ALREADY_EXISTS_ACTIVE');
        expect(operations).toContain('customer-profile-source.write');
        expect(personalCalls).toBe(0);
        expect(yield* read({ ...authority, effectId: source.effectId, mode: 'ORG_RECEIPT' })).toEqual(original);
        const unsupportedEffectId = randomUUID();
        const unsupportedWitnessPayload = yield* Schema.decodeUnknownEffect(
          CreateCounterpartyPurchasingProfilePayloadSchema,
        )({
          ...payload,
          source: {
            ...source,
            effectId: unsupportedEffectId,
            occurrenceId: 'company-17-unsupported',
            order: 3,
            revision: '3',
          },
          sourceOrganizationWitness: {
            effectId: unsupportedEffectId,
            originalAdmissionInvocationId: randomUUID(),
            semanticInputDigest: 'a'.repeat(64),
            semanticProjectionVersion: 'unsupported-semantic-version',
          },
        });
        expect(yield* Effect.flip(create(unsupportedWitnessPayload))).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
        expect(personalCalls).toBe(0);
        denyWrite = true;
        expect(
          yield* Effect.flip(
            create({
              ...update,
              source: {
                ...source,
                effectId: 'organization-update-3',
                occurrenceId: 'company-17-r3',
                order: 3,
                revision: '3',
              },
            }),
          ),
        ).toMatchObject({ code: 'PRIVACY_DENIED' });
        denyWrite = false;
        expect(yield* admin.select().from(customerProfileSourceReceipts)).toHaveLength(2);
        expect((yield* admin.select().from(customerProfileSourceBindings))[0]?.sourceOrder).toBe(2);
        expect(yield* admin.select().from(customerProfiles)).toHaveLength(1);
        expect(yield* Effect.flip(read({ ...authority, effectId: source.effectId, mode: 'RECEIPT' }))).toMatchObject({
          code: 'read_handler_unavailable',
        });
        expect(
          yield* Effect.flip(read({ ...authority, effectId: 'unknown-organization-effect', mode: 'ORG_RECEIPT' })),
        ).toMatchObject({ code: 'read_handler_not_found' });
        deny = true;
        expect(
          yield* Effect.flip(read({ ...authority, effectId: source.effectId, mode: 'ORG_RECEIPT' })),
        ).toMatchObject({ code: 'read_handler_unavailable' });
        expect(yield* Effect.flip(read({ ...authority, mode: 'CURRENT', recordId: source.recordId }))).toMatchObject({
          code: 'read_handler_unavailable',
        });
        return yield* Effect.void;
      }),
    ).pipe(Effect.provide(platform)),
  180_000,
);
