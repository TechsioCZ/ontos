import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ActiveApplicationCompositionSnapshotSchema,
  ActionPayloadValidationError,
  ActionRuntime,
  ReadHandlerUnavailable,
  ReadRuntime,
  ContextAccessLive,
  ContextPermissionRelationshipMutation,
  ContextPermissionRelationshipMutationLive,
  PrincipalRefSchema,
} from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeQuantityProfileOwnedDatabase } from '../support/quantity-profile-owned-database.ts';
import { makeQuantityProfileDatabaseTransport } from '../support/quantity-profile-database-transport.ts';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Reactivity } from 'effect/reactivity';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { NodeChildProcessSpawner, NodeCrypto, NodeHttpServer, NodeServices } from '@effect/platform-node';
import { Context, DateTime, Deferred, Effect, Fiber, Layer, Option, Redacted, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { FetchHttpClient, HttpServer, HttpServerResponse } from 'effect/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { assert, expect, it } from 'effect-rstest';
import {
  CommerceQuantityAssignmentPayloadSchema,
  CommerceQuantityRuleAdministrationPayloadSchema,
  CustomerCommercePolicyAdministrationRejected,
  currentCommerceQuantityAssignmentSet,
} from '../../shared/domain/customer-commerce-policy-administration.ts';
import { administerCommerceQuantityRuleAction } from '../../src/actions/administer-commerce-quantity-rule.action.ts';
import { assignCommerceQuantityRuleAction } from '../../src/actions/assign-commerce-quantity-rule.action.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { customerCommercePolicyRepositoryForScope } from '../../src/persistence/customer-commerce-policy-persistence.ts';
import { openProfileReconciliationAction } from '../../src/actions/open-profile-reconciliation.action.ts';
import { ensureRetailCustomerProfileAction } from '../../src/actions/ensure-retail-customer-profile.action.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { suspendCustomerProfileAction } from '../../src/actions/suspend-customer-profile.action.ts';
import { archiveCustomerProfileAction } from '../../src/actions/archive-customer-profile.action.ts';
import {
  CommerceQuantityPolicyCurrentAuthenticationProblemSchema,
  CommerceQuantityPolicyCurrentRequestSchema,
  CommerceQuantityPolicyCurrentResponseSchema,
  CommerceQuantityPolicyCurrentUnavailableProblemSchema,
} from '../../shared/apis/commerce-quantity-policy-current.ts';
import { executeCommerceQuantityPolicyCurrentWithAuthorization } from '../../src/api/commerce-quantity-policy-current-client.ts';
import { commerceQuantityPolicyCurrentRead } from '../../src/api/commerce-quantity-policy-current.read.ts';
import { PartyRegistryRetailPartyResolverFactory } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import { makeEnrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const transport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'commerce.customer-context',
});
const makeQuantityProfileFixture = Effect.fn('QuantityProfileAdmissionTests.fixture')(function* makeFixture(
  buildMarker = 'quantity-profile-admission-native',
  databaseTransportMode: 'DIRECT' | 'OWNER_LOOKUP_OUTAGE' = 'DIRECT',
) {
  const snapshot = yield* makeEnrollmentApplicationCompositionSnapshot(buildMarker, []);
  const { isolated } = yield* makeQuantityProfileOwnedDatabase(snapshot);
  const databaseTransport =
    databaseTransportMode === 'OWNER_LOOKUP_OUTAGE'
      ? yield* makeQuantityProfileDatabaseTransport(Redacted.make(isolated.connections.runtime.connectionString))
      : undefined;
  const coreEvidenceContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(coreEvidenceContext));
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      actionExecutor: 'manager-only',
      actionKeys: [
        ensureRetailCustomerProfileAction.descriptor.actionKey,
        createCounterpartyPurchasingProfileAction.descriptor.actionKey,
        administerCommerceQuantityRuleAction.descriptor.actionKey,
        assignCommerceQuantityRuleAction.descriptor.actionKey,
        suspendCustomerProfileAction.descriptor.actionKey,
        archiveCustomerProfileAction.descriptor.actionKey,
        openProfileReconciliationAction.descriptor.actionKey,
      ],
      additionalLegalEntity: 'same-tenant',
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      moduleKeys: ['commerce.customer-context'],
      runtimeConnectionString:
        databaseTransport?.connectionString ?? Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const secondary = fixture.secondaryLegalEntity;
  assert.isOk(secondary !== undefined);
  const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
  const partyIds = new Set<string>([randomUUID(), randomUUID(), randomUUID()]);
  const counterpartyId = randomUUID();
  const roleId = randomUUID();
  // TEST leaf facts only: these exact Tenant/Party/role identities stand in for Party metadata.
  // Unknown input fails closed. CCC identities are produced by the registered Actions below;
  // this fixture makes no claim about Party producer correctness or transport availability.
  const owners = Layer.mergeAll(
    Layer.succeed(PartyRegistryRetailPartyResolverFactory, {
      make: (scope) => (request) =>
        Effect.succeed(
          scope.tenantId === fixture.tenantId &&
            request.tenantId === fixture.tenantId &&
            partyIds.has(request.partyResourceId)
            ? {
                outcome: 'CURRENT_PARTY_RESOLVED' as const,
                partyResourceId: request.partyResourceId,
                partyResourceRevision: '1',
              }
            : { outcome: 'INVALID_OR_INSUFFICIENT_EVIDENCE' as const },
        ),
    }),
    Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
      make: (scope) => (request) =>
        Effect.succeed(
          request.tenantId === fixture.tenantId &&
            scope.tenantId === fixture.tenantId &&
            request.counterpartyResourceId === counterpartyId &&
            [fixture.legalEntityId, secondary.legalEntityId].includes(scope.legalEntityId)
            ? {
                managedLegalEntityId: scope.legalEntityId,
                outcome: 'ELIGIBLE' as const,
                roleResourceId: roleId,
                roleResourceRevision: '2026-01-01T00:00:00.000Z',
              }
            : { outcome: 'INDETERMINATE' as const },
        ),
    }),
    partyRegistryGuestResolverFactoryLive,
    profileRetailPermissionReaderFactoryLive.pipe(Layer.provide(ContextAccessLive)),
    profileReactivationEligibilityEvaluatorFactoryLive.pipe(Layer.provide(profileReconfirmationPolicyUnavailableLive)),
    commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
      Layer.provide(profileRetailPermissionReaderFactoryLive),
      Layer.provide(ContextAccessLive),
    ),
  );
  const context = yield* Layer.build(fixture.layer.pipe(Layer.provideMerge(owners)));
  const runtime = Context.get(context, ActionRuntime);
  const readRuntime = Context.get(context, ReadRuntime);

  const effectiveAt = DateTime.formatIso(yield* DateTime.now);
  const createRetail = (partyId: string) =>
    runtime
      .runAction({
        payload: {
          effectiveAt,
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
          trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
        },
        principal,
        registration: ensureRetailCustomerProfileAction,
        transport: transport(),
      })
      .pipe(Effect.provideContext(context));
  const createCounterparty = runtime
    .runAction({
      payload: {
        effectiveAt,
        subject: {
          counterpartyRef: {
            moduleId: 'party.registry',
            resourceId: counterpartyId,
            resourceType: 'party.registry.counterparty',
            tenantId: fixture.tenantId,
          },
          kind: 'COUNTERPARTY',
        },
        trigger: 'ENSURE_BEFORE_ORDER_ACCEPTANCE',
      },
      principal,
      registration: createCounterpartyPurchasingProfileAction,
      transport: transport(),
    })
    .pipe(Effect.provideContext(context));
  const [partyId] = partyIds;
  assert.isOk(partyId !== undefined);
  const retail = yield* createRetail(partyId);
  const counterparty = yield* createCounterparty;
  yield* fixture.grantResourceAccess(retail.profileRef, fixture.manager.principalId, 'writer');
  yield* fixture.grantResourceAccess(counterparty.profileRef, fixture.manager.principalId, 'writer');
  yield* ContextPermissionRelationshipMutation.pipe(
    Effect.flatMap((permission) =>
      permission.mutate({
        legalEntityId: fixture.legalEntityId,
        operation: 'grant',
        principal: Schema.decodeUnknownSync(PrincipalRefSchema)({
          principalId: fixture.manager.principalId,
          tenantId: fixture.tenantId,
        }),
        target: { moduleId: 'commerce.customer-context', permission: 'customer_commerce_policy.quantity.read' },
        tenantId: fixture.tenantId,
      }),
    ),
    Effect.provide(ContextPermissionRelationshipMutationLive),
  );
  return {
    context,
    coreEvidenceExecutor,
    counterparty,
    createRetail,
    databaseTransport,
    effectiveAt,
    fixture,
    isolated,
    partyIds,
    principal,
    readRuntime,
    retail,
    runtime,
    secondary,
    snapshot,
    transport,
  };
});

const createRule = (owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>, secondary = false) => {
  const revisionId = randomUUID();
  return owner.runtime
    .runAction({
      payload: Schema.decodeUnknownSync(CommerceQuantityRuleAdministrationPayloadSchema)({
        _tag: 'CREATE_REVISION',
        expectedGeneration: 0,
        revision: {
          effectiveFrom: '2020-01-01T00:00:00.000Z',
          effectiveTo: null,
          field: 'COMMERCE_QUANTITY_RULE',
          idempotencyKey: randomUUID(),
          lifecycle: 'ACTIVE',
          reason: 'Native concrete profile admission',
          revisionId,
          scope: {
            channelId: 'web',
            kind: 'CHANNEL_SELLER',
            sellingLegalEntityId: secondary ? owner.secondary.legalEntityId : owner.fixture.legalEntityId,
          },
          value: {
            audience: 'ASSIGNMENT_ONLY',
            basis: {
              targetDivisibilityRevision: 1,
              targetRef: {
                moduleId: 'commerce.catalog',
                resourceId: '55555555-5555-4555-8555-555555555555',
                resourceType: 'commerce.catalog.variant',
                tenantId: owner.fixture.tenantId,
              },
              unitRef: {
                moduleId: 'commerce.catalog',
                resourceId: '66666666-6666-4666-8666-666666666666',
                resourceType: 'commerce.catalog.product-unit',
                tenantId: owner.fixture.tenantId,
              },
              unitRuleRevision: 1,
            },
            constraintMode: 'REPLACEABLE_ENVELOPE',
            envelope: { kind: 'NO_COMMERCIAL_QUANTITY_RESTRICTION' },
            kind: 'COMMERCE_QUANTITY_RULE',
            selector: { kind: 'ALL' },
          },
        },
      }),
      principal: secondary ? owner.secondary.manager : owner.principal,
      registration: administerCommerceQuantityRuleAction,
      transport: owner.transport(),
    })
    .pipe(Effect.provideContext(owner.context), Effect.as(revisionId));
};
const assignmentInput = (
  owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>,
  ruleId: string,
  profile: {
    readonly kind: 'RETAIL' | 'COUNTERPARTY';
    readonly profileRef: {
      readonly moduleId: string;
      readonly resourceId: string;
      readonly resourceType: string;
      readonly tenantId: string;
    };
  },
  expectedGeneration: number,
  effectiveFrom = '2026-01-01T00:00:00.000Z',
) =>
  Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
    _tag: 'ASSIGN',
    assignment: {
      assignmentId: randomUUID(),
      effectiveFrom,
      effectiveTo: null,
      idempotencyKey: randomUUID(),
      lifecycle: 'ACTIVE',
      profile,
      reason: 'Native concrete target proof',
      ruleRevisionRef: {
        moduleId: 'commerce.customer-context',
        resourceId: ruleId,
        resourceType: 'commerce.customer-context.commerce-quantity-rule',
        tenantId: owner.fixture.tenantId,
      },
    },
    expectedGeneration,
  });
const assign = (
  owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>,
  payload: typeof CommerceQuantityAssignmentPayloadSchema.Type,
  secondary = false,
) =>
  owner.runtime
    .runAction({
      payload,
      principal: secondary ? owner.secondary.manager : owner.principal,
      registration: assignCommerceQuantityRuleAction,
      transport: owner.transport(),
    })
    .pipe(Effect.provideContext(owner.context));
const current = (owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>, at: string) =>
  owner.readRuntime
    .runRead({
      input: { at },
      principal: owner.principal,
      registration: commerceQuantityPolicyCurrentRead,
      transport: { correlationId: randomUUID() },
    })
    .pipe(Effect.provideContext(owner.context));

it.live(
  'admits concrete Retail and tenant-global Counterparty profiles and rejects missing, wrong-kind and wrong-seller targets',
  () =>
    Effect.scoped(
      Effect.gen(function* concreteProfileTargets() {
        const owner = yield* makeQuantityProfileFixture();
        const ruleId = yield* createRule(owner);
        const retail = { kind: 'RETAIL' as const, profileRef: owner.retail.profileRef };
        const counterparty = { kind: 'COUNTERPARTY' as const, profileRef: owner.counterparty.profileRef };
        const missing = { ...retail, profileRef: { ...retail.profileRef, resourceId: randomUUID() } };
        const wrongKind = {
          ...retail,
          profileRef: { ...retail.profileRef, resourceId: owner.counterparty.profileRef.resourceId },
        };
        const before = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
        for (const profile of [missing, wrongKind]) {
          const failure = yield* Effect.flip(assign(owner, assignmentInput(owner, ruleId, profile, 0)));
          const typed = yield* Schema.decodeUnknownEffect(CustomerCommercePolicyAdministrationRejected)(failure);
          expect(typed).toMatchObject({ code: 'BROKEN_ASSIGNMENT', retryable: false });
          expect(typed.reason).toBe(
            profile === missing
              ? 'Commerce Quantity assignment profile does not exist in its owner scope'
              : 'Commerce Quantity assignment profile has a different owner kind',
          );
        }
        const afterDenied = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
        expect(afterDenied.events).toHaveLength(before.events.length);
        expect(afterDenied.outbox).toHaveLength(before.outbox.length);
        const foreignRef = {
          ...retail,
          profileRef: { ...retail.profileRef, tenantId: randomUUID() },
        };
        const foreign = yield* Effect.flip(assign(owner, assignmentInput(owner, ruleId, foreignRef, 0)));
        expect(yield* Schema.decodeUnknownEffect(CustomerCommercePolicyAdministrationRejected)(foreign)).toMatchObject({
          code: 'SCOPE_MISMATCH',
          reason: 'Assignment references do not match the trusted scope',
          retryable: false,
        });
        const malformedProfile = { ...retail, profileRef: { ...retail.profileRef, moduleId: 'foreign.owner' } };
        const malformed = yield* Effect.flip(
          owner.runtime
            .runAction({
              payload: {
                _tag: 'ASSIGN',
                assignment: {
                  assignmentId: randomUUID(),
                  effectiveFrom: '2026-01-01T00:00:00.000Z',
                  effectiveTo: null,
                  idempotencyKey: randomUUID(),
                  lifecycle: 'ACTIVE',
                  profile: malformedProfile,
                  reason: 'Invalid owner type',
                  ruleRevisionRef: {
                    moduleId: 'commerce.customer-context',
                    resourceId: ruleId,
                    resourceType: 'commerce.customer-context.commerce-quantity-rule',
                    tenantId: owner.fixture.tenantId,
                  },
                },
                expectedGeneration: 0,
              },
              principal: owner.principal,
              registration: assignCommerceQuantityRuleAction,
              transport: owner.transport(),
            })
            .pipe(Effect.provideContext(owner.context)),
        );
        expect(yield* Schema.decodeUnknownEffect(ActionPayloadValidationError)(malformed)).toMatchObject({
          code: 'action_payload_invalid',
          reason: 'The Action payload does not match its declared schema',
        });
        const payload = assignmentInput(owner, ruleId, retail, 0);
        const accepted = yield* assign(owner, payload);
        expect(accepted).toMatchObject({ changed: true, generation: 1 });
        const replay = yield* assign(owner, payload);
        expect(replay).toMatchObject({ changed: false, generation: 1 });
        const stale = yield* Effect.flip(assign(owner, assignmentInput(owner, ruleId, counterparty, 0)));
        expect(yield* Schema.decodeUnknownEffect(CustomerCommercePolicyAdministrationRejected)(stale)).toMatchObject({
          code: 'GENERATION_CONFLICT',
          retryable: false,
        });
        const cpAccepted = yield* assign(owner, assignmentInput(owner, ruleId, counterparty, 1));
        expect(cpAccepted).toMatchObject({ changed: true, generation: 2 });
        const projected = yield* current(owner, owner.effectiveAt);
        expect(projected.assignmentSet.assignments).toHaveLength(2);
        const ruleLB = yield* createRule(owner, true);
        const cpLB = yield* assign(owner, assignmentInput(owner, ruleLB, counterparty, 0), true);
        expect(cpLB).toMatchObject({ changed: true, generation: 1 });
        const retailLB = yield* Effect.flip(assign(owner, assignmentInput(owner, ruleLB, retail, 1), true));
        expect(yield* Schema.decodeUnknownEffect(CustomerCommercePolicyAdministrationRejected)(retailLB)).toMatchObject(
          {
            code: 'BROKEN_ASSIGNMENT',
            reason: 'Commerce Quantity assignment profile does not exist in its owner scope',
            retryable: false,
          },
        );
        const recovered = yield* current(owner, owner.effectiveAt);
        expect(recovered.assignmentSet).toEqual(projected.assignmentSet);
      }),
    ).pipe(Effect.provide(nativeServices)),
);

it.live(
  'preserves concrete suspended and archived profile settings, future boundaries and append-only UNASSIGN history',
  () =>
    Effect.scoped(
      Effect.gen(function* retainedLifecycleAndTime() {
        const owner = yield* makeQuantityProfileFixture();
        const ruleId = yield* createRule(owner);
        const retail = { kind: 'RETAIL' as const, profileRef: owner.retail.profileRef };
        const suspended = yield* owner.runtime
          .runAction({
            payload: {
              effectiveAt: owner.effectiveAt,
              expectedRevision: 1,
              expectedState: 'ACTIVE',
              profileRef: { kind: 'RETAIL', ...owner.retail.profileRef },
              reason: 'Native suspended identity settings',
            },
            principal: owner.principal,
            registration: suspendCustomerProfileAction,
            transport: owner.transport(),
          })
          .pipe(Effect.provideContext(owner.context));
        expect(suspended.state).toBe('SUSPENDED');
        const futureAt = '2035-01-01T00:00:00.000Z';
        const future = assignmentInput(owner, ruleId, retail, 0, futureAt);
        const accepted = yield* assign(owner, future);
        expect(accepted.changed).toBe(true);
        expect((yield* current(owner, '2034-12-31T23:59:59.999Z')).assignmentSet.assignments).toEqual([]);
        expect((yield* current(owner, futureAt)).assignmentSet.assignments).toHaveLength(1);
        const archived = yield* owner.runtime
          .runAction({
            payload: {
              effectiveAt: owner.effectiveAt,
              expectedRevision: suspended.revision,
              expectedState: 'SUSPENDED',
              profileRef: { kind: 'RETAIL', ...owner.retail.profileRef },
              reason: 'Native archived identity settings',
            },
            principal: owner.principal,
            registration: archiveCustomerProfileAction,
            transport: owner.transport(),
          })
          .pipe(Effect.provideContext(owner.context));
        expect(archived.state).toBe('ARCHIVED');
        expect((yield* current(owner, futureAt)).assignmentSet.assignments).toHaveLength(1);
        const [assignmentId] = accepted.revisionIds;
        assert.isOk(assignmentId !== undefined);
        const unassigned = yield* assign(
          owner,
          Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
            _tag: 'UNASSIGN',
            assignmentId,
            effectiveAt: '2036-01-01T00:00:00.000Z',
            expectedGeneration: 1,
            idempotencyKey: randomUUID(),
            reason: 'Retain immutable relation, end its applicability',
          }),
        );
        expect(unassigned).toMatchObject({ changed: true, generation: 2 });
        expect((yield* current(owner, '2035-12-31T23:59:59.999Z')).assignmentSet.assignments).toHaveLength(1);
        expect((yield* current(owner, '2036-01-01T00:00:00.000Z')).assignmentSet.assignments).toEqual([]);
        const archivedNew = yield* assign(owner, assignmentInput(owner, ruleId, retail, 2, '2036-01-01T00:00:00.000Z'));
        expect(archivedNew).toMatchObject({ changed: true, generation: 3 });
      }),
    ).pipe(Effect.provide(nativeServices)),
);

const openRetailReconciliation = Effect.fn('QuantityProfileAdmissionTests.openRetailReconciliation')(
  function* openReconciliation(owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>) {
    const [, secondPartyId] = owner.partyIds;
    const [canonicalPartyId] = owner.partyIds;
    assert.isOk(secondPartyId !== undefined && canonicalPartyId !== undefined);
    const collision = yield* owner.createRetail(secondPartyId);
    const opened = yield* owner.runtime
      .runAction({
        payload: {
          canonicalizationEvidence: {
            decisionRef: randomUUID(),
            evidenceKind: 'AUTHORIZED_OPERATOR_DECISION',
            observedAt: owner.effectiveAt,
            policyVersion: 'native-1266-test-operator.v1',
          },
          detectedAt: owner.effectiveAt,
          evidenceRef: randomUUID(),
          profileRefs: [
            { kind: 'RETAIL', ...owner.retail.profileRef },
            { kind: 'RETAIL', ...collision.profileRef },
          ],
          reason: 'Native owner reconciliation uncertainty',
          targetSubject: {
            kind: 'RETAIL',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: canonicalPartyId,
              resourceType: 'party.registry.party',
              tenantId: owner.fixture.tenantId,
            },
            sellingLegalEntityRef: {
              moduleId: 'core.identity',
              resourceId: owner.fixture.legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId: owner.fixture.tenantId,
            },
          },
          trigger: 'CREATE_COLLISION',
        },
        principal: owner.principal,
        registration: openProfileReconciliationAction,
        transport: owner.transport(),
      })
      .pipe(Effect.provideContext(owner.context));
    return opened;
  },
);

const withProfileLock = <Value, Failure, Requirements>(
  owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>,
  admin: EffectPgDatabase<typeof commerceCustomerContextRelations>,
  profileId: string,
  probe: Effect.Effect<Value, Failure, Requirements>,
) =>
  Effect.gen(function* lockedOwnerProbe() {
    const ready = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const blocker = yield* admin
      .transaction((transaction) =>
        Effect.gen(function* heldOwnerProfile() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${owner.fixture.tenantId}, true), set_config('ontos.legal_entity_id', ${owner.fixture.legalEntityId}, true)`,
          );
          yield* transaction.execute(sql`select customer_profile_id from commerce_customer_context.customer_profiles
  where tenant_id = ${owner.fixture.tenantId}::uuid and customer_profile_id = ${profileId}::uuid for update`);
          yield* Deferred.succeed(ready, true);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    return yield* probe.pipe(
      Effect.ensuring(Deferred.succeed(release, true).pipe(Effect.andThen(Fiber.join(blocker).pipe(Effect.orDie)))),
    );
  });

it.live(
  'distinguishes NOWAIT contention and owner reconciliation from absence and refuses stale Current positives',
  () =>
    Effect.scoped(
      Effect.gen(function* currentProfileTruth() {
        const owner = yield* makeQuantityProfileFixture();
        const ruleId = yield* createRule(owner);
        const retail = { kind: 'RETAIL' as const, profileRef: owner.retail.profileRef };
        const counterparty = { kind: 'COUNTERPARTY' as const, profileRef: owner.counterparty.profileRef };
        const accepted = yield* assign(owner, assignmentInput(owner, ruleId, retail, 0));
        const client = yield* PgClient.make({
          url: Redacted.make(owner.isolated.connections.admin.connectionString),
        }).pipe(Effect.provide(Reactivity.layer));
        const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
          Effect.provideService(PgClient.PgClient, client),
        );
        const busyAssignment = yield* withProfileLock(
          owner,
          admin,
          owner.counterparty.profileRef.resourceId,
          Effect.flip(assign(owner, assignmentInput(owner, ruleId, counterparty, 1))),
        );
        expect(
          yield* Schema.decodeUnknownEffect(CustomerCommercePolicyAdministrationRejected)(busyAssignment),
        ).toMatchObject({
          code: 'PERSISTENCE_UNAVAILABLE',
          reason: 'Commerce Quantity assignment profile is busy; retry its owner verification',
          retryable: true,
        });
        const busyRead = yield* withProfileLock(
          owner,
          admin,
          owner.retail.profileRef.resourceId,
          Effect.flip(current(owner, owner.effectiveAt)),
        );
        expect(yield* Schema.decodeUnknownEffect(ReadHandlerUnavailable)(busyRead)).toMatchObject({
          code: 'read_handler_unavailable',
          reason: 'Current Commerce Quantity policy is temporarily unavailable',
        });
        const recovered = yield* current(owner, owner.effectiveAt);
        expect(recovered.assignmentSet.assignments).toHaveLength(1);
        const cpAccepted = yield* assign(owner, assignmentInput(owner, ruleId, counterparty, 1));
        expect(cpAccepted).toMatchObject({ changed: true, generation: 2 });
        const opened = yield* openRetailReconciliation(owner);
        expect(opened.outcome).toBe('RECONCILIATION_OPENED');
        const indeterminate = yield* Effect.flip(current(owner, owner.effectiveAt));
        expect(yield* Schema.decodeUnknownEffect(ReadHandlerUnavailable)(indeterminate)).toMatchObject({
          code: 'read_handler_unavailable',
          reason: 'Current Commerce Quantity policy is temporarily unavailable',
        });
        const [assignmentId] = accepted.revisionIds;
        assert.isOk(assignmentId !== undefined);
        const unassigned = yield* assign(
          owner,
          Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
            _tag: 'UNASSIGN',
            assignmentId,
            effectiveAt: owner.effectiveAt,
            expectedGeneration: 2,
            idempotencyKey: randomUUID(),
            reason: 'End applicability while retaining uncertain owner history',
          }),
        );
        expect(unassigned).toMatchObject({ changed: true, generation: 3 });
        const cpOnly = yield* current(owner, owner.effectiveAt);
        expect(cpOnly.assignmentSet.assignments).toHaveLength(1);
        expect(cpOnly.assignmentSet.assignments[0]?.profile).toEqual(counterparty);
      }),
    ).pipe(Effect.provide(nativeServices)),
);

it.live(
  'enforces concrete profile identity inside the native new-insert guard and retains old relations unchanged',
  () =>
    Effect.scoped(
      Effect.gen(function* nativeAssignmentGuard() {
        const owner = yield* makeQuantityProfileFixture();
        const ruleId = yield* createRule(owner);
        yield* assign(
          owner,
          assignmentInput(owner, ruleId, { kind: 'RETAIL', profileRef: owner.retail.profileRef }, 0),
        );
        const evidence = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
        const retained = yield* owner.fixture
          .prepareOwner(
            (transaction, scope) =>
              Effect.gen(function* originalRetainedState() {
                const repository = yield* customerCommercePolicyRepositoryForScope(transaction, scope);
                return yield* repository.loadCommerceQuantityRuleAssignments;
              }),
            'required',
          )
          .pipe(Effect.provideContext(owner.context));
        const failure = yield* owner.fixture
          .prepareOwner(
            (transaction, scope) =>
              Effect.gen(function* rawOwnerGuard() {
                const repository = yield* customerCommercePolicyRepositoryForScope(transaction, scope);
                const state = yield* repository.loadCommerceQuantityRuleAssignments;
                const [existing] = state.assignments;
                assert.isOk(existing !== undefined);
                const nextState: typeof state = {
                  ...state,
                  assignments: [
                    ...state.assignments,
                    {
                      ...existing,
                      assignmentId: randomUUID(),
                      idempotencyKey: randomUUID(),
                      profile: {
                        kind: 'RETAIL',
                        profileRef: { ...owner.retail.profileRef, resourceId: randomUUID() },
                      },
                    },
                  ],
                  generation: state.generation + 1,
                };
                return yield* repository.persistCommerceQuantityRuleAssignments(state.generation, {
                  completeness: currentCommerceQuantityAssignmentSet(nextState, owner.effectiveAt).completeness,
                  state: nextState,
                });
              }),
            'required',
          )
          .pipe(Effect.provideContext(owner.context), Effect.flip);
        expect(failure).toMatchObject({
          code: 'BROKEN_ASSIGNMENT',
          reason: 'Commerce Quantity assignment profile does not exist in its owner scope',
          retryable: false,
        });
        const persisted = yield* owner.fixture
          .prepareOwner(
            (transaction, scope) =>
              Effect.gen(function* retainedState() {
                const repository = yield* customerCommercePolicyRepositoryForScope(transaction, scope);
                return yield* repository.loadCommerceQuantityRuleAssignments;
              }),
            'required',
          )
          .pipe(Effect.provideContext(owner.context));
        expect(persisted).toEqual(retained);
        const after = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
        expect(after.events).toHaveLength(evidence.events.length);
        expect(after.outbox).toHaveLength(evidence.outbox.length);
      }),
    ).pipe(Effect.provide(nativeServices)),
);

const appRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const QuantityReceiverMarkerSchema = Schema.Struct({
  appId: Schema.Literal('commerce-customer-context'),
  buildMarker: Schema.String.check(Schema.isMinLength(1)),
});
const QuantityReceiverReadySchema = Schema.Struct({
  marker: QuantityReceiverMarkerSchema,
  port: Schema.Number,
  type: Schema.Literal('ready'),
});
const quantityHttpServices = NodeHttpServer.layerTest.pipe(Layer.provideMerge(nativeServices));
const prepareQuantityReceiverArtifact = Effect.fn('QuantityProfileAdmissionTests.receiverArtifact')(
  function* prepareReceiver() {
    const artifact = fileURLToPath(
      new URL(`../../node_modules/.cache/ontos-1266/${randomUUID()}.mjs`, import.meta.url),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => rm(artifact, { force: true })));
    const bundle = yield* ChildProcess.make(
      'mise',
      [
        'exec',
        '--',
        'pnpm',
        'exec',
        'esbuild',
        'verticals/commerce-customer-context/tests/support/purchase-resolution-permission-plan-receiver.fixture.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--packages=external',
        `--outfile=${artifact}`,
      ],
      { cwd: appRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    const [bundleExit] = yield* Effect.all(
      [bundle.exitCode, Stream.runDrain(bundle.stdout), Stream.runDrain(bundle.stderr)],
      { concurrency: 3 },
    );
    expect(Number(bundleExit)).toBe(0);
    const description = yield* ChildProcess.make(process.execPath, [artifact, '--describe'], {
      cwd: appRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    const [descriptionExit, lines] = yield* Effect.all(
      [
        description.exitCode,
        description.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect),
        Stream.runDrain(description.stderr),
      ],
      { concurrency: 3 },
    );
    expect(Number(descriptionExit)).toBe(0);
    const [line] = lines;
    assert.isOk(line !== undefined);
    const marker = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QuantityReceiverMarkerSchema))(line);
    return { artifact, marker };
  },
);
const startQuantityPublicReceiver = Effect.fn('QuantityProfileAdmissionTests.publicReceiver')(function* startReceiver(
  owner: Effect.Success<ReturnType<typeof makeQuantityProfileFixture>>,
  prepared: Effect.Success<ReturnType<typeof prepareQuantityReceiverArtifact>>,
) {
  const pair = yield* Effect.promise(() => generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true }));
  const publicJwk = yield* Effect.promise(() => exportJWK(pair.publicKey));
  const issuer = 'https://native-quantity-profile.ontos.test';
  const kid = 'quantity-profile-native';
  const jwks = yield* Schema.encodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ keys: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) })),
  )({ keys: [{ ...publicJwk, alg: 'EdDSA', kid, use: 'sig' }] });
  const snapshotDocument = yield* Schema.encodeEffect(
    Schema.fromJsonString(ActiveApplicationCompositionSnapshotSchema),
  )(owner.snapshot);
  const source = yield* HttpServer.HttpServer;
  yield* source.serve(Effect.succeed(HttpServerResponse.text(snapshotDocument, { contentType: 'application/json' })));
  const { address } = source;
  if (!Schema.is(Schema.Struct({ port: Schema.Number }))(address)) {
    return yield* Effect.die('The Quantity composition source requires a loopback TCP address');
  }
  const child = yield* ChildProcess.make(process.execPath, [prepared.artifact], {
    cwd: appRoot,
    env: {
      APP_ENV_PATH: '/dev/null',
      DATABASE_ADMIN_URL: owner.isolated.connections.admin.connectionString,
      DATABASE_URL: owner.isolated.connections.runtime.connectionString,
      ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL: `http://127.0.0.1:${address.port}/active-composition`,
      ONTOS_GATEWAY_ISSUER: issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: jwks,
    },
    extendEnv: true,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
  const line = yield* child.stdout.pipe(Stream.decodeText(), Stream.splitLines, Stream.runHead);
  assert.isOk(Option.isSome(line));
  const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(QuantityReceiverReadySchema))(line.value);
  expect(ready.marker).toEqual(prepared.marker);
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  const clockClient = yield* PgClient.make({
    url: Redacted.make(owner.isolated.connections.runtime.connectionString),
  }).pipe(Effect.provide(Reactivity.layer));
  const clock = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provideService(PgClient.PgClient, clockClient),
  );
  // TEST issuer/transport only. The unmodified receiver verifies crypto, redeems in PostgreSQL,
  // resolves the real staff binding/LE, authorizes through actual SpiceDB and runs the real read.
  const freshAssertion = Effect.fn('QuantityProfileAdmissionTests.freshHttpAssertion')(function* issueAssertion() {
    const [row] = yield* clock.execute<{ readonly epoch: number }>(
      sql`select floor(extract(epoch from clock_timestamp()))::integer as epoch`,
      'objects',
    );
    const { epoch } = yield* Schema.decodeUnknownEffect(Schema.Struct({ epoch: Schema.Int }))(row);
    return yield* Effect.promise(() =>
      new SignJWT({
        compositionRevision: owner.snapshot.composition.revision,
        principal: owner.principal,
        targetBuildMarker: ready.marker.buildMarker,
        ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
      })
        .setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT' })
        .setAudience('commerce-customer-context')
        .setIssuer(issuer)
        .setSubject(owner.principal.principalId)
        .setIssuedAt(epoch)
        .setExpirationTime(epoch + GATEWAY_ASSERTION_TTL_SECONDS)
        .setJti(randomUUID())
        .sign(pair.privateKey),
    );
  });
  const read = (at: string, assertion: string) =>
    executeCommerceQuantityPolicyCurrentWithAuthorization(
      Schema.decodeUnknownSync(CommerceQuantityPolicyCurrentRequestSchema)({ at }),
      `Bearer ${assertion}`,
      randomUUID(),
      { baseUrl, compositionRevision: owner.snapshot.composition.revision },
    ).pipe(Effect.provide(FetchHttpClient.layer));
  return { freshAssertion, read };
});

it.live(
  'serves concrete Quantity Current over production HTTP, redeems assertions, and recovers after owner uncertainty',
  () =>
    Effect.scoped(
      Effect.gen(function* receivingQuantityCurrent() {
        // Describe the actual receiving artifact BEFORE the owned composition is published.
        const prepared = yield* prepareQuantityReceiverArtifact();
        const owner = yield* makeQuantityProfileFixture(prepared.marker.buildMarker);
        const ruleId = yield* createRule(owner);
        const retail = { kind: 'RETAIL' as const, profileRef: owner.retail.profileRef };
        const counterparty = { kind: 'COUNTERPARTY' as const, profileRef: owner.counterparty.profileRef };
        const accepted = yield* assign(owner, assignmentInput(owner, ruleId, retail, 0));
        yield* assign(owner, assignmentInput(owner, ruleId, counterparty, 1));
        const receiver = yield* startQuantityPublicReceiver(owner, prepared);
        const initialAssertion = yield* receiver.freshAssertion();
        const available = yield* receiver.read(owner.effectiveAt, initialAssertion);
        const verified = yield* Schema.decodeUnknownEffect(CommerceQuantityPolicyCurrentResponseSchema)(available);
        expect(verified).toEqual(yield* current(owner, owner.effectiveAt));
        expect(verified.assignmentSet.assignments).toHaveLength(2);
        const replay = yield* Effect.flip(receiver.read(owner.effectiveAt, initialAssertion));
        expect(
          yield* Schema.decodeUnknownEffect(CommerceQuantityPolicyCurrentAuthenticationProblemSchema)(replay),
        ).toMatchObject({ status: 401 });
        const fresh = yield* receiver.read(owner.effectiveAt, yield* receiver.freshAssertion());
        expect(fresh).toEqual(verified);
        const opened = yield* openRetailReconciliation(owner);
        expect(opened.outcome).toBe('RECONCILIATION_OPENED');
        const unavailable = yield* Effect.flip(receiver.read(owner.effectiveAt, yield* receiver.freshAssertion()));
        expect(
          yield* Schema.decodeUnknownEffect(CommerceQuantityPolicyCurrentUnavailableProblemSchema)(unavailable),
        ).toMatchObject({
          detail: 'The governed read is temporarily unavailable.',
          retryable: true,
          status: 503,
        });
        const [assignmentId] = accepted.revisionIds;
        assert.isOk(assignmentId !== undefined);
        const unassigned = yield* assign(
          owner,
          Schema.decodeUnknownSync(CommerceQuantityAssignmentPayloadSchema)({
            _tag: 'UNASSIGN',
            assignmentId,
            effectiveAt: owner.effectiveAt,
            expectedGeneration: 2,
            idempotencyKey: randomUUID(),
            reason: 'End uncertain target applicability without rewriting history',
          }),
        );
        expect(unassigned).toMatchObject({ changed: true, generation: 3 });
        const recovered = yield* receiver.read(owner.effectiveAt, yield* receiver.freshAssertion());
        expect(recovered).toEqual(yield* current(owner, owner.effectiveAt));
        expect(recovered.assignmentSet.assignments).toHaveLength(1);
        expect(recovered.assignmentSet.assignments[0]?.profile).toEqual(counterparty);
      }),
    ).pipe(Effect.provide(quantityHttpServices)),
  // Native clone, receiver, and owner recovery measured 30.35s with 47 assertions completed.
  120_000,
);

it.live(
  'refuses an actual owner database transport outage without stale Quantity Current and recovers unchanged state',
  () =>
    Effect.scoped(
      Effect.gen(function* unavailableQuantityOwnerDatabase() {
        const owner = yield* makeQuantityProfileFixture(
          'quantity-profile-owner-database-outage',
          'OWNER_LOOKUP_OUTAGE',
        );
        const wire = owner.databaseTransport;
        assert.isOk(wire !== undefined);
        const ruleId = yield* createRule(owner);
        yield* assign(
          owner,
          assignmentInput(owner, ruleId, { kind: 'RETAIL', profileRef: owner.retail.profileRef }, 0),
        );
        const positive = yield* current(owner, owner.effectiveAt);
        expect(positive.assignmentSet.assignments).toHaveLength(1);
        expect(positive.assignmentSet.assignments[0]?.profile.profileRef).toEqual(owner.retail.profileRef);
        expect(wire.observed().matchedQueryCount).toBeGreaterThan(0);
        const before = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
        yield* wire.arm;
        const unavailable = yield* Effect.suspend(() => current(owner, owner.effectiveAt)).pipe(
          Effect.flip,
          Effect.timeout('5 seconds'),
        );
        expect(yield* Schema.decodeUnknownEffect(ReadHandlerUnavailable)(unavailable)).toMatchObject({
          code: 'read_handler_unavailable',
          reason: 'The governed read database connection is temporarily unavailable',
        });
        expect(wire.observed().cutCount).toBe(1);
        const recovered = yield* current(owner, owner.effectiveAt);
        expect(recovered.assignmentSet).toEqual(positive.assignmentSet);
        const after = yield* owner.fixture.evidence(owner.coreEvidenceExecutor);
        expect(after.events).toHaveLength(before.events.length);
        expect(after.outbox).toHaveLength(before.outbox.length);
        expect(after.invocations).toHaveLength(before.invocations.length);
        yield* wire.close;
        expect(wire.observed()).toMatchObject({ activeSockets: 0, cutCount: 1, listenerOpen: false });
      }),
    ).pipe(Effect.provide(nativeServices)),
);
