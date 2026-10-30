import { consumePurchaseApprovalAction } from '../../src/actions/consume-purchase-approval.action.ts';
import { revokeCounterpartyCommerceAccessAction } from '../../src/actions/revoke-counterparty-commerce-access.action.ts';
import { suspendCustomerProfileAction } from '../../src/actions/suspend-customer-profile.action.ts';
import { revalidatePurchaseApprovalAction } from '../../src/actions/revalidate-purchase-approval.action.ts';
import { randomUUID } from 'node:crypto';
import {
  ActiveApplicationCompositionService,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  ContextAccessLive,
  GatewayAssertionRedemptionService,
  PrincipalEligibilityLive,
  defineScopedRoutine,
  runAction,
} from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot, loadDatabaseConnectionPair } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { bindGatewayPrincipalVerifier } from '@app/gateway-principal-verifier/server';
import { EXTERNAL_GATEWAY_ASSERTION_VERSION, GATEWAY_ASSERTION_TTL_SECONDS } from '@app/shared-contracts';
import { PgClient } from '@effect/sql-pg';
import { sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, DateTime, Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  GatewayAssertionRedemptionDatabaseLive,
  GatewayAssertionRedemptionLive,
} from '../../api/auth/gateway-assertion-redemption.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { CounterpartyRefSchema } from '../../shared/domain/access-contract.ts';
import {
  CounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofDelivery,
} from '../../shared/domain/invitation-proof-delivery.ts';
import {
  PurchaseLimitEvaluationCurrentFactsSchema,
  PurchaseLimitEvaluationCurrentnessPort,
} from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import type { PurchaseLimitEvaluationCurrentnessPortService } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-policy.ts';
import { PurchaseLimitSourceRevisionVectorSchema } from '../../shared/domain/purchase-limit-evaluation.ts';
import {
  ApprovalHierarchySchema,
  DecidePurchaseApprovalRequestInputSchema,
  PurchaseProposalRevisionSchema,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';
import type { DecidePurchaseApprovalRequestInput } from '../../shared/domain/purchasing-approval.ts';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';
import { ChangeCounterpartyPurchaseLimitPayloadSchema } from '../../shared/actions/change-counterparty-purchase-limit.ts';
import { CreatePurchaseProposalRevisionPayloadSchema } from '../../shared/actions/create-purchase-proposal-revision.ts';
import { CreateApprovalHierarchyPayloadSchema } from '../../shared/actions/create-approval-hierarchy.ts';
import { SubmitPurchaseApprovalRequestPayloadSchema } from '../../shared/actions/submit-purchase-approval-request.ts';
import { DecidePurchaseApprovalRequestPayloadSchema } from '../../shared/actions/decide-purchase-approval-request.ts';
import { createCounterpartyPurchasingProfileAction } from '../../src/actions/create-counterparty-purchasing-profile.action.ts';
import { changeCounterpartyPurchaseLimitAction } from '../../src/actions/change-counterparty-purchase-limit.action.ts';
import { createPurchaseProposalRevisionAction } from '../../src/actions/create-purchase-proposal-revision.action.ts';
import { createApprovalHierarchyAction } from '../../src/actions/create-approval-hierarchy.action.ts';
import { submitPurchaseApprovalRequestAction } from '../../src/actions/submit-purchase-approval-request.action.ts';
import { decidePurchaseApprovalRequestAction } from '../../src/actions/decide-purchase-approval-request.action.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { commerceCustomerContextOwnerAuthorizationOverlayLive } from '../../src/persistence/owner-authorization-overlay.ts';
import {
  purchaseLimitPersistenceLayer,
  readCurrentPurchaseLimitPolicyState,
} from '../../src/persistence/purchase-limit-persistence.ts';
import { purchaseApprovalCurrentnessFactoryLive } from '../../src/persistence/purchase-approval-currentness-persistence.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { profileRetailPermissionReaderFactoryLive } from '../../src/integrations/retail-permission-reader.ts';
import {
  profileReactivationEligibilityEvaluatorFactoryLive,
  profileReconfirmationPolicyUnavailableLive,
} from '../../src/integrations/profile-reactivation-eligibility.ts';
import { partyRegistryGuestResolverFactoryLive } from '../../src/integrations/party-registry-guest-resolver.ts';
import { partyRegistryRetailPartyResolverFactoryLive } from '../../src/integrations/party-registry-retail-party-resolver.ts';
import { purchasingApprovalCommercialFixture } from '../unit/purchasing-approval-fixtures.ts';

/** Shared native construction path: domain values stay decoded until the exact Core wire boundary. */
export const purchasingApprovalNativePayloads = {
  decide: (command: DecidePurchaseApprovalRequestInput, patch: Partial<DecidePurchaseApprovalRequestInput> = {}) =>
    Schema.encodeEffect(DecidePurchaseApprovalRequestPayloadSchema)({ ...command, ...patch }),
  hierarchy: (hierarchy: typeof ApprovalHierarchySchema.Type, idempotencyKey: string) =>
    Schema.encodeEffect(CreateApprovalHierarchyPayloadSchema)({ hierarchy, idempotencyKey }),
  limit: (counterpartyRef: typeof CounterpartyRefSchema.Type) =>
    Schema.encodeEffect(ChangeCounterpartyPurchaseLimitPayloadSchema)(
      Schema.decodeUnknownSync(ChangeCounterpartyPurchaseLimitPayloadSchema)({
        change: { _tag: 'SET', policy: { _tag: 'MONETARY_LIMIT', limit: { amount: '50', currency: 'EUR' } } },
        counterpartyRef,
        expectedRevision: null,
        reason: 'TEST real Approval-required owner policy',
      }),
    ),
  profile: (counterpartyRef: typeof CounterpartyRefSchema.Type, effectiveAt: string) =>
    Schema.encodeEffect(CreateCounterpartyPurchasingProfilePayloadSchema)({
      effectiveAt,
      subject: { counterpartyRef, kind: 'COUNTERPARTY' },
      trigger: 'AUTHORIZED_ONBOARDING',
    }),
  proposal: (
    proposal: typeof PurchaseProposalRevisionSchema.Type,
    sources: typeof PurchaseLimitSourceRevisionVectorSchema.Type,
    idempotencyKey: string,
  ) =>
    Schema.encodeEffect(CreatePurchaseProposalRevisionPayloadSchema)({
      idempotencyKey,
      proposal,
      verifiedEvidence: {
        buyerPermission: 'ALLOWED',
        profileState: 'ACTIVE',
        proposalCurrent: true,
        sourceRevisions: sources,
      },
    }),
  submit: (proposal: typeof PurchaseProposalRevisionSchema.Type, idempotencyKey: string) =>
    Schema.encodeEffect(SubmitPurchaseApprovalRequestPayloadSchema)({
      counterpartyRef: proposal.identity.counterpartyRef,
      idempotencyKey,
      proposalRevision: proposal.revision,
      proposalRevisionRef: proposal.proposalRevisionRef,
      requestExpiresAt: proposal.expiresAt,
      storefrontId: proposal.context.storefrontId,
    }),
};

const ownerModuleKey = 'commerce.customer-context';
const audience = 'commerce-customer-context';
const storefrontId = 'native-approval-storefront';
const buyerSubmitPermission = 'counterparty.purchase.submit';
const money = (amount: string) => ({ amount, currency: 'EUR' });
const observationNow = () => DateTime.now;
export const beginGrant = defineScopedRoutine({
  name: 'begin_access_grant',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { nullable: true, source: 'input', type: 'text' },
    { source: 'input', type: 'boolean' },
  ],
  resultSchema: Schema.Struct({ grant_id: Schema.String, mutation_id: Schema.String }),
  routineKey: 'test.approval.initial-grant',
  schema: 'commerce_customer_context',
});
export const settleGrant = defineScopedRoutine({
  name: 'transition_access_grant',
  ownerModuleKey,
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'uuid' },
    { source: 'input', type: 'text' },
    { source: 'input', type: 'text' },
  ],
  resultSchema: Schema.Struct({ state: Schema.Literals(['ACTIVE', 'REVOKED']) }),
  routineKey: 'test.approval.settle-initial-grant',
  schema: 'commerce_customer_context',
});

/**
 * Owned-native TEST composition. The issuer and external role/Cart facts below are explicit test
 * preconditions. They do not prove Shell issuance, production providers, or deployment readiness.
 * All profile, policy, proposal, hierarchy, request and Decision mutations use real registered Actions.
 */
export const makePurchasingApprovalNativeFixture = Effect.fn('PurchasingApprovalNative.make')(
  function* makePurchasingApprovalNativeFixture(input: {
    readonly apiKeyManager?: boolean;
    readonly connections: Effect.Success<ReturnType<typeof loadDatabaseConnectionPair>>;
    readonly finalProofTest?: true;
    readonly snapshot: ActiveApplicationCompositionSnapshot;
  }) {
    const fixture = yield* Effect.acquireRelease(
      makeLiveOperationFixture({
        actionExecutor: 'manager-only',
        actionKeys: [
          createCounterpartyPurchasingProfileAction,
          changeCounterpartyPurchaseLimitAction,
          createPurchaseProposalRevisionAction,
          createApprovalHierarchyAction,
          submitPurchaseApprovalRequestAction,
          decidePurchaseApprovalRequestAction,
          ...(input.finalProofTest === true
            ? [
                consumePurchaseApprovalAction,
                revalidatePurchaseApprovalAction,
                revokeCounterpartyCommerceAccessAction,
                suspendCustomerProfileAction,
              ]
            : []),
        ].map((action) => action.descriptor.actionKey),
        adminConnectionString: Redacted.make(input.connections.admin.connectionString),
        allowedAudiences: [audience],
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        authenticationSubjectTypes: input.finalProofTest === true ? ['user', 'api_key'] : ['user'],
        compositionRevision: input.snapshot.composition.revision,
        managerAuthenticationMethod: input.apiKeyManager === true ? 'api_key' : 'session',
        moduleKeys: [ownerModuleKey],
        runtimeConnectionString: Redacted.make(input.connections.runtime.connectionString),
      }),
      (resource) => resource.close().pipe(Effect.orDie),
    );
    const { legalEntityId, tenantId } = fixture;
    const principal = { principalId: fixture.manager.principalId, tenantId };
    const adminLayer = PgClient.layer({ url: Redacted.make(input.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    );
    const adminContext = yield* Layer.build(adminLayer);
    const coreEvidenceExecutor = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
    const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
      Effect.provide(adminContext),
    );
    const nativeNow = () =>
      Effect.gen(function* readNativeClock() {
        const [row] = yield* admin.execute<{ at: string; epoch: number }>(
          sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at, floor(extract(epoch from clock_timestamp()))::integer as epoch`,
          'objects',
        );
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({ at: Schema.DateTimeUtcFromString, epoch: Schema.Int }),
        )(row);
      });
    const roleFacts = new Map<string, { readonly at: string; readonly roleId: string }>();
    const candidates = new Map<
      string,
      {
        readonly facts: typeof PurchaseLimitEvaluationCurrentFactsSchema.Type;
        readonly proposal: typeof PurchaseProposalRevisionSchema.Type;
        readonly sources: typeof PurchaseLimitSourceRevisionVectorSchema.Type;
        readonly sourcesByKey: ReadonlyMap<string, string>;
      }
    >();
    const roleLayer = Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
      make:
        (scope) =>
        ({ counterpartyResourceId, tenantId: targetTenant }) => {
          const known = roleFacts.get(counterpartyResourceId);
          return Effect.succeed(
            known !== undefined &&
              scope.tenantId === tenantId &&
              targetTenant === tenantId &&
              scope.legalEntityId === legalEntityId
              ? {
                  managedLegalEntityId: legalEntityId,
                  outcome: 'ELIGIBLE' as const,
                  roleResourceId: known.roleId,
                  roleResourceRevision: known.at,
                }
              : { outcome: 'INDETERMINATE' as const },
          );
        },
    });
    const currentFacts: PurchaseLimitEvaluationCurrentnessPortService['resolveCurrent'] = (request) =>
      Effect.gen(function* resolveExactTESTCurrentFacts() {
        const known = candidates.get(request.claimedPurchaseValue.sourceRef);
        const exact =
          known !== undefined &&
          request.scope.tenantId === tenantId &&
          request.scope.legalEntityId === legalEntityId &&
          request.scope.principalId === principal.principalId &&
          request.scope.storefrontId === storefrontId &&
          request.counterpartyRef.resourceId === known.proposal.identity.counterpartyRef.resourceId &&
          request.counterpartyRef.tenantId === tenantId &&
          JSON.stringify(request.claimedPurchaseValue) === JSON.stringify(known.proposal.purchaseValue) &&
          request.expectedSourceRevisions.length === known.sources.length &&
          request.expectedSourceRevisions.every(
            (revision) => known.sourcesByKey.get(revision.source) === revision.revision,
          );
        if (!exact || known === undefined) {
          return yield* Effect.fail(
            Schema.decodeUnknownSync(PurchaseLimitDependencyUnavailableSchema)({
              _tag: 'PurchaseLimitDependencyUnavailable',
              code: 'purchase_limit_dependency_unavailable',
              dependency: 'TEST_EXACT_APPROVAL_SOURCE',
              reason: 'This TEST source has no authoritative evidence for that exact request',
            }),
          );
        }
        // TEST source observations share the consumer's Effect clock, not PostgreSQL's independent clock.
        const current = yield* observationNow();
        if (
          DateTime.isLessThan(request.observedAt, known.proposal.createdAt) ||
          DateTime.isGreaterThan(request.observedAt, current)
        ) {
          return yield* Effect.fail(
            Schema.decodeUnknownSync(PurchaseLimitDependencyUnavailableSchema)({
              _tag: 'PurchaseLimitDependencyUnavailable',
              code: 'purchase_limit_dependency_unavailable',
              dependency: 'TEST_EXACT_APPROVAL_SOURCE',
              reason: 'The requested observation is outside the known TEST fact interval',
            }),
          );
        }
        return known.facts;
      });
    const currentLayer = Layer.succeed(PurchaseLimitEvaluationCurrentnessPort, {
      resolveCandidate: currentFacts,
      resolveCurrent: currentFacts,
    });
    const ordinaryDependencies = Layer.mergeAll(
      roleLayer,
      currentLayer,
      ContextAccessLive,
      PrincipalEligibilityLive,
      BusinessPermissionRelationshipMutationLive,
      profileRetailPermissionReaderFactoryLive,
      profileReactivationEligibilityEvaluatorFactoryLive,
      partyRegistryGuestResolverFactoryLive,
      partyRegistryRetailPartyResolverFactoryLive,
      Layer.succeed(CounterpartyInvitationProofDelivery, unavailableCounterpartyInvitationProofDelivery()),
    ).pipe(Layer.provide(ContextAccessLive), Layer.provide(profileReconfirmationPolicyUnavailableLive));
    const overlay = commerceCustomerContextOwnerAuthorizationOverlayLive.pipe(
      Layer.provide(profileRetailPermissionReaderFactoryLive),
      Layer.provide(ContextAccessLive),
    );
    const coreLayer = fixture.layer.pipe(Layer.provide(overlay));
    const actualOwners = Layer.mergeAll(purchaseLimitPersistenceLayer, purchaseApprovalCurrentnessFactoryLive).pipe(
      Layer.provideMerge(ordinaryDependencies),
      Layer.provideMerge(coreLayer),
    );
    const runtimeContext = yield* Layer.build(actualOwners);
    const redemptionLayer = GatewayAssertionRedemptionLive.pipe(
      Layer.provide(GatewayAssertionRedemptionDatabaseLive),
      Layer.provide(
        PgClient.layer({ url: Redacted.make(input.connections.runtime.connectionString) }).pipe(
          Layer.provideMerge(Reactivity.layer),
        ),
      ),
    );
    const redemption = Context.get(yield* Layer.build(redemptionLayer), GatewayAssertionRedemptionService);
    const pair = yield* Effect.promise(async () => await generateKeyPair('EdDSA'));
    const jwk = yield* Effect.promise(async () => await exportJWK(pair.publicKey));
    const issuer = 'https://approval-native-test.invalid';
    const verifier = bindGatewayPrincipalVerifier(audience, ultramodernApiMarker);
    const authenticatedPrincipal = Effect.fn('PurchasingApprovalNative.authenticateTESTIssuer')(
      function* authenticateTESTIssuer(actor = fixture.manager) {
        const clock = yield* nativeNow();
        const token = yield* Effect.promise(
          async () =>
            await new SignJWT({
              compositionRevision: input.snapshot.composition.revision,
              principal: { ...actor, legalEntityId, trustedStorefrontId: storefrontId },
              targetBuildMarker: ultramodernApiMarker.buildMarker,
              ver: EXTERNAL_GATEWAY_ASSERTION_VERSION,
            })
              .setProtectedHeader({ alg: 'EdDSA', kid: 'approval-native-test', typ: 'JWT' })
              .setIssuer(issuer)
              .setAudience(audience)
              .setSubject(actor.principalId)
              .setIssuedAt(clock.epoch)
              .setExpirationTime(clock.epoch + GATEWAY_ASSERTION_TTL_SECONDS)
              .setJti(randomUUID())
              .sign(pair.privateKey),
        );
        return yield* verifier
          .verifyAndRedeem(Redacted.make(`Bearer ${token}`), {
            environment: {
              ONTOS_GATEWAY_ISSUER: issuer,
              ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({
                keys: [{ ...jwk, alg: 'EdDSA', kid: 'approval-native-test', use: 'sig' }],
              }),
            },
            redemption,
          })
          .pipe(Effect.provideService(ActiveApplicationCompositionService, { load: Effect.succeed(input.snapshot) }));
      },
    );
    const transport = (idempotencyKey = randomUUID()) => ({
      correlationId: randomUUID(),
      idempotencyKey,
      targetModuleKey: ownerModuleKey,
    });

    // Fixture-level completion of the real staged mutation protocol, not execution of an Outbox Worker.
    const settleBuyerRevocation = (
      counterpartyRef: typeof CounterpartyRefSchema.Type,
      grantId: string,
      mutationId: string,
    ) =>
      Effect.gen(function* settleActualBuyerRevocation() {
        yield* Context.get(runtimeContext, BusinessPermissionRelationshipMutation).mutate({
          operation: 'revoke',
          permission: buyerSubmitPermission,
          principal,
          target: { counterpartyId: counterpartyRef.resourceId, kind: 'counterparty', legalEntityId, tenantId },
        });
        return yield* fixture
          .prepareOwner(
            (transaction) => transaction.invoke(settleGrant, [grantId, mutationId, 'revoke', 'REVOKED']),
            'required',
          )
          .pipe(Effect.provideContext(runtimeContext));
      });

    const createRequest = Effect.fn('PurchasingApprovalNative.createRequest')(function* createRequest({
      deliveryAddress = { country: 'CZ' },
      hierarchyTtlMilliseconds,
      invoiceAddress = { country: 'CZ' },
      ttlMilliseconds = 5000,
      twoLevels = false,
      wrongApprover = false,
    }: {
      readonly deliveryAddress?: Readonly<Record<string, string>>;
      readonly hierarchyTtlMilliseconds?: number;
      readonly invoiceAddress?: Readonly<Record<string, string>>;
      readonly ttlMilliseconds?: number;
      readonly twoLevels?: boolean;
      readonly wrongApprover?: boolean;
    } = {}) {
      const counterpartyRef = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema)({
        moduleId: 'party.registry',
        resourceId: randomUUID(),
        resourceType: 'party.registry.counterparty',
        tenantId,
      });
      const roleAt = DateTime.formatIso((yield* nativeNow()).at);
      roleFacts.set(counterpartyRef.resourceId, { at: roleAt, roleId: randomUUID() });
      const profile = yield* runAction({
        payload: yield* purchasingApprovalNativePayloads.profile(counterpartyRef, roleAt),
        principal: yield* authenticatedPrincipal(),
        registration: createCounterpartyPurchasingProfileAction,
        transport: transport(),
      }).pipe(Effect.provideContext(runtimeContext));
      // Authorized initial-authorization fixture prerequisite, matching the existing CCC native pattern.
      // Attribution UUIDs below identify fixture setup only: they are NOT Core Action invocations.
      // No bootstrap Action, production provisioning or API-key verification is claimed by this setup.
      for (const permission of [
        'counterparty.access.manage',
        'counterparty.purchase_limit.manage',
        buyerSubmitPermission,
        'counterparty.approval_hierarchy.manage',
        'counterparty.approval.request.manage',
        'counterparty.approval.decide',
      ] as const) {
        const prepared = yield* fixture
          .prepareOwner(
            (transaction) =>
              transaction.invoke(beginGrant, [
                counterpartyRef.resourceId,
                principal.principalId,
                permission,
                null,
                principal.principalId,
                randomUUID(),
                'TEST initial exact Approval authorization prerequisite',
                permission === 'counterparty.access.manage',
              ]),
            'required',
          )
          .pipe(Effect.provideContext(runtimeContext));
        const [grant] = prepared;
        if (grant === undefined) {
          return yield* Effect.die('The native initial grant was not prepared');
        }
        const mutation = Context.get(runtimeContext, BusinessPermissionRelationshipMutation);
        const relation = {
          permission,
          principal,
          target: {
            counterpartyId: counterpartyRef.resourceId,
            kind: 'counterparty' as const,
            legalEntityId,
            tenantId,
          },
        };
        yield* mutation.mutate({ ...relation, operation: 'grant' });
        yield* Effect.addFinalizer(() => mutation.mutate({ ...relation, operation: 'revoke' }).pipe(Effect.orDie));
        yield* fixture
          .prepareOwner(
            (transaction) => transaction.invoke(settleGrant, [grant.grant_id, grant.mutation_id, 'grant', 'ACTIVE']),
            'required',
          )
          .pipe(Effect.provideContext(runtimeContext));
      }
      yield* runAction({
        payload: yield* purchasingApprovalNativePayloads.limit(counterpartyRef),
        principal: yield* authenticatedPrincipal(),
        registration: changeCounterpartyPurchaseLimitAction,
        transport: transport(),
      }).pipe(Effect.provideContext(runtimeContext));
      const policy = yield* fixture
        .prepareOwner(
          (transaction) =>
            readCurrentPurchaseLimitPolicyState(transaction, { counterpartyRef, principalRef: principal, tenantId }),
          'required',
        )
        .pipe(Effect.provideContext(runtimeContext));
      const at = yield* observationNow();
      const atText = DateTime.formatIso(at);
      const expiresAtText = DateTime.formatIso(DateTime.add(at, { milliseconds: ttlMilliseconds }));
      const proposalId = randomUUID();
      const commercial = purchasingApprovalCommercialFixture({ money, tenantId });
      const candidate = yield* Schema.decodeUnknownEffect(PurchaseProposalRevisionSchema)({
        approvalEvaluation: 'APPROVAL_REQUIRED',
        approvalTrigger: {
          policyRevision: policy.sourceRevisions[0]?.revision,
          reasonCode: 'over_limit',
          source: 'PURCHASE_LIMIT',
        },
        canonicalHash: '0'.repeat(64),
        canonicalizationVersion: 'purchase-proposal.v1',
        context: {
          channelId: 'portal',
          evaluatedAt: atText,
          locale: 'en-US',
          marketId: 'eu',
          sellingLegalEntityId: legalEntityId,
          storefrontId,
          tenantId,
        },
        createdAt: atText,
        currency: 'EUR',
        deliveryDestination: { address: deliveryAddress, kind: 'DELIVERY', method: 'DELIVERY_ADDRESS' },
        effectiveLimit: money('50'),
        expiresAt: expiresAtText,
        hierarchyInputs: { counterpartyRef, evaluatedAt: atText, purchaseValue: money('120'), storefrontId },
        identity: { buyer: principal, counterpartyRef, profileRef: profile.profileRef },
        invoiceRecipient: { address: invoiceAddress, kind: 'INVOICE', method: 'BILLING_ADDRESS' },
        ...commercial,
        payment: 'NONE',
        paymentTerm: {
          code: 'NET30',
          definitionRef: {
            moduleId: 'payment-term-catalog',
            resourceId: 'net-30',
            resourceType: 'payment-term-catalog.payment-term-definition',
            tenantId,
          },
          definitionRevision: '1',
        },
        policyRefs: [],
        pricingRevision: 'pricing-r1',
        proposalRevisionRef: {
          moduleId: ownerModuleKey,
          resourceId: proposalId,
          resourceType: 'commerce.customer-context.purchase-proposal-revision',
          tenantId,
        },
        proposalSequence: 1,
        purchaseValue: { ...commercial.purchaseValue, sourceRef: proposalId },
        reservation: 'NONE',
        revision: 1,
        sourceCart: {
          ...commercial.sourceCart,
          cartRef: { ...commercial.sourceCart.cartRef, resourceId: `cart:${proposalId}` },
        },
        state: 'CURRENT',
        taxRevision: 'tax-r1',
      });
      const proposal = { ...candidate, canonicalHash: computePurchaseProposalCanonicalHash(candidate) };
      const sources = yield* Schema.decodeUnknownEffect(PurchaseLimitSourceRevisionVectorSchema)([
        ...policy.sourceRevisions,
        { revision: '1', source: 'customer-commerce-policy' },
        { revision: proposal.purchaseValue.sourceRevision, source: 'purchase-proposal' },
        { revision: String(profile.revision), source: 'purchasing-profile' },
        { revision: '1', source: 'storefront-context' },
      ]);
      candidates.set(proposal.purchaseValue.sourceRef, {
        facts: yield* Schema.decodeUnknownEffect(PurchaseLimitEvaluationCurrentFactsSchema)({
          channelId: 'portal',
          contextRevision: '1',
          currentSourceRevisions: sources.filter(
            ({ source }) => source !== 'counterparty-policy' && source !== 'principal-override',
          ),
          marketId: 'eu',
          purchaseValue: proposal.purchaseValue,
        }),
        proposal,
        sources,
        sourcesByKey: new Map(sources.map(({ revision, source }) => [source, revision])),
      });
      yield* runAction({
        payload: yield* purchasingApprovalNativePayloads.proposal(proposal, sources, randomUUID()),
        principal: yield* authenticatedPrincipal(),
        registration: createPurchaseProposalRevisionAction,
        transport: transport(),
      }).pipe(Effect.provideContext(runtimeContext));
      const hierarchy = yield* Schema.decodeUnknownEffect(ApprovalHierarchySchema)({
        createdAt: atText,
        effectiveFrom: atText,
        effectiveTo:
          hierarchyTtlMilliseconds === undefined
            ? null
            : DateTime.formatIso(DateTime.add(at, { milliseconds: hierarchyTtlMilliseconds })),
        hierarchyRef: {
          moduleId: ownerModuleKey,
          resourceId: randomUUID(),
          resourceType: 'commerce.customer-context.approval-hierarchy',
          tenantId,
        },
        levels: [
          {
            completionRule: 'ONE_APPROVER',
            eligiblePrincipals: [wrongApprover ? { principalId: fixture.reader.principalId, tenantId } : principal],
            levelId: 'one',
            order: 1,
            scopeConstraints: [],
          },
          ...(twoLevels
            ? [
                {
                  completionRule: 'ONE_APPROVER',
                  eligiblePrincipals: [principal],
                  levelId: 'two',
                  order: 2,
                  scopeConstraints: [],
                },
              ]
            : []),
        ],
        ownerPrincipal: principal,
        reason: 'TEST native expiry route',
        revision: 1,
        selector: { counterpartyRef, maximumPurchaseValue: null, minimumPurchaseValue: money('0'), storefrontId },
        selfApprovalPolicy: 'ALLOW',
        state: 'ACTIVE',
      });
      yield* runAction({
        payload: yield* purchasingApprovalNativePayloads.hierarchy(hierarchy, randomUUID()),
        principal: yield* authenticatedPrincipal(),
        registration: createApprovalHierarchyAction,
        transport: transport(),
      }).pipe(Effect.provideContext(runtimeContext));
      const request = yield* runAction({
        payload: yield* purchasingApprovalNativePayloads.submit(proposal, randomUUID()),
        principal: yield* authenticatedPrincipal(),
        registration: submitPurchaseApprovalRequestAction,
        transport: transport(),
      }).pipe(Effect.provideContext(runtimeContext));
      const command = yield* Schema.decodeUnknownEffect(DecidePurchaseApprovalRequestInputSchema)({
        actor: principal,
        counterpartyRef,
        decidedAt: atText,
        decision: 'APPROVE',
        expectedRequestRevision: request.request.requestRevision,
        idempotencyKey: randomUUID(),
        proposalRevisionRef: proposal.proposalRevisionRef,
        reason: null,
        requestRef: request.request.requestRef,
        storefrontId,
      });
      const decide = (patch: Partial<DecidePurchaseApprovalRequestInput> = {}) =>
        Effect.gen(function* decideRealRegisteredAction() {
          return yield* runAction({
            payload: yield* purchasingApprovalNativePayloads.decide(command, patch),
            principal: yield* authenticatedPrincipal(),
            registration: decidePurchaseApprovalRequestAction,
            transport: transport(),
          }).pipe(Effect.provideContext(runtimeContext));
        });
      return {
        // Explicit external Current-port component control; no owner business rows are changed.
        changeCurrentFacts: (patch: Partial<typeof PurchaseLimitEvaluationCurrentFactsSchema.Type>) =>
          Effect.gen(function* changeTESTCurrentPortFacts() {
            const known = candidates.get(proposal.purchaseValue.sourceRef);
            if (known === undefined) {
              return yield* Effect.die('The native component candidate has not been registered');
            }
            candidates.set(proposal.purchaseValue.sourceRef, { ...known, facts: { ...known.facts, ...patch } });
            return yield* Effect.void;
          }),
        changeLimit: () =>
          Effect.gen(function* changeActualOwnerPolicy() {
            return yield* runAction({
              payload: yield* Schema.encodeEffect(ChangeCounterpartyPurchaseLimitPayloadSchema)(
                Schema.decodeUnknownSync(ChangeCounterpartyPurchaseLimitPayloadSchema)({
                  change: { _tag: 'SET', policy: { _tag: 'MONETARY_LIMIT', limit: money('60') } },
                  counterpartyRef,
                  expectedRevision: policy.counterpartyPolicies[0]?.revision ?? null,
                  reason: 'TEST actual policy revision change between Approval proofs',
                }),
              ),
              principal: yield* authenticatedPrincipal(),
              registration: changeCounterpartyPurchaseLimitAction,
              transport: transport(),
            }).pipe(Effect.provideContext(runtimeContext));
          }),
        command,
        counterpartyRef,
        decide,
        expiresAtText,
        hierarchy,
        profile,
        proposal,
        request,
        revokeBuyer: () =>
          Effect.gen(function* requestActualBuyerRevocation() {
            return yield* runAction({
              payload: yield* Schema.encodeEffect(revokeCounterpartyCommerceAccessAction.descriptor.payloadSchema)({
                counterpartyRef,
                permission: buyerSubmitPermission,
                reason: 'TEST actual buyer revocation between Approval proofs',
                recipient: principal,
                scope: { kind: 'counterparty' },
              }),
              principal: yield* authenticatedPrincipal(),
              registration: revokeCounterpartyCommerceAccessAction,
              transport: transport(),
            }).pipe(Effect.provideContext(runtimeContext));
          }),
        sourceRevisions: sources,
        suspendProfile: () =>
          Effect.gen(function* suspendActualOwnerProfile() {
            return yield* runAction({
              payload: yield* Schema.encodeEffect(suspendCustomerProfileAction.descriptor.payloadSchema)({
                effectiveAt: DateTime.formatIso((yield* nativeNow()).at),
                expectedRevision: profile.revision,
                expectedState: 'ACTIVE',
                profileRef: { ...profile.profileRef, kind: 'COUNTERPARTY' },
                reason: 'TEST actual profile suspension between Approval proofs',
              }),
              principal: yield* authenticatedPrincipal(),
              registration: suspendCustomerProfileAction,
              transport: transport(),
            }).pipe(Effect.provideContext(runtimeContext));
          }),
      };
    });
    return {
      admin,
      authenticatedPrincipal,
      authorizeRecoveryReader: (counterpartyRef: typeof CounterpartyRefSchema.Type) =>
        Effect.gen(function* authorizeDifferentTESTBuyerForRecovery() {
          const reader = fixture.legalEntityOnly;
          const [grant] = yield* fixture
            .prepareOwner(
              (transaction) =>
                transaction.invoke(beginGrant, [
                  counterpartyRef.resourceId,
                  reader.principalId,
                  buyerSubmitPermission,
                  null,
                  principal.principalId,
                  randomUUID(),
                  'TEST recovery reader authorization prerequisite',
                  false,
                ]),
              'required',
            )
            .pipe(Effect.provideContext(runtimeContext));
          if (grant === undefined) {
            return yield* Effect.die('The TEST recovery reader grant was not prepared');
          }
          const mutation = Context.get(runtimeContext, BusinessPermissionRelationshipMutation);
          const relation = {
            permission: buyerSubmitPermission,
            principal: { principalId: reader.principalId, tenantId },
            target: {
              counterpartyId: counterpartyRef.resourceId,
              kind: 'counterparty' as const,
              legalEntityId,
              tenantId,
            },
          };
          yield* mutation.mutate({ ...relation, operation: 'grant' });
          yield* Effect.addFinalizer(() => mutation.mutate({ ...relation, operation: 'revoke' }).pipe(Effect.orDie));
          yield* fixture
            .prepareOwner(
              (transaction) => transaction.invoke(settleGrant, [grant.grant_id, grant.mutation_id, 'grant', 'ACTIVE']),
              'required',
            )
            .pipe(Effect.provideContext(runtimeContext));
          return reader;
        }),
      coreEvidenceExecutor,
      createRequest,
      fixture,
      legalEntityId,
      nativeNow,
      observationNow,
      principal,
      runtimeContext,
      settleBuyerRevocation,
      storefrontId,
      tenantId,
    };
  },
);
