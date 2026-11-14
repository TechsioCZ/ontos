import { stableRevision } from '../stable-revision.ts';
import { executeCurrentStorefrontApplicationWithAuthorization } from '@app/storefront-registry-contracts/current-storefront-application/client';
import { CurrentStorefrontApplicationRequestSchema } from '@app/storefront-registry-contracts/current-storefront-application';
import { executeEligibleMarketTuplesWithAuthorization } from '@app/commerce-market-catalog/api/client';
import { acquireDelegatedGatewayContext } from '@app/shared-contracts/gateway-context-server';
import { PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { isVerifiedGatewayPrincipalContext, readVerifiedGatewayActor } from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { Crypto, DateTime, Effect, Match, Option, Schema, Predicate } from 'effect';
import { OrderFinalizationPricingContextSchema } from '../../shared/domain/order-finalization-pricing-context.ts';
import {
  PurchaseApprovalRequestSchema,
  computePurchaseProposalCanonicalHash,
} from '../../shared/domain/purchasing-approval.ts';
import type { PurchaseApprovalRequest, PurchaseProposalRevision } from '../../shared/domain/purchasing-approval.ts';
import {
  PurchaseCurrencyResolutionRequestSchema,
  resolvePurchaseCurrency,
  PurchaseCurrencySubjectSchema,
} from '../../shared/domain/purchase-currency-resolution.ts';
import { CommerceCustomerProfileRefSchema } from '../../shared/domain/profile-decisions.ts';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { readOrderBuyerPermissionForVerifiedSubject } from '../persistence/purchase-approval-currentness-persistence.ts';
import { customerCommercePolicyRepositoryForScope } from '../persistence/customer-commerce-policy-persistence.ts';
import { customerPriceGroupAssignmentStoreForTransaction } from '../persistence/price-group-persistence.ts';
import { readCurrentPurchaseApprovalRevalidationRoutine } from '../persistence/purchasing-approval-persistence.ts';
import { profilePersistenceServicesForTransaction } from '../persistence/profile-persistence.ts';
import {
  ProfileCounterpartyRoleEligibilityResolverFactory,
  assertPreparedCounterpartyRoleCurrent,
} from '../profile-counterparty-role-eligibility.ts';
import { composeCurrentPurchaseCurrencyPolicy } from './purchase-currency-policy.ts';
import { currentPurchaseCurrencyPolicySet } from '../../shared/domain/customer-commerce-policy-administration.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from './purchase-currency-pricing.ts';
import {
  PricingPurchaseContextOwnerUnavailable,
  PricingPurchaseContextOwnerUnverifiable,
} from '../services/pricing-purchase-context-owner-authority.ts';
import type { PricingPurchaseContextVerificationRequest } from '../../shared/apis/pricing-purchase-context-verification.ts';

const contextPrefix = 'ccc:order-finalization:';
const MODULE_ID = 'commerce.customer-context' as const;

const unavailable = (cause: unknown) =>
  Object.defineProperty(
    new PricingPurchaseContextOwnerUnavailable({
      reason: 'The current approved Order Pricing context cannot be established',
    }),
    'cause',
    { value: cause },
  );
const invalid = () =>
  new PricingPurchaseContextOwnerUnverifiable({
    reason: 'The approved Order Pricing context does not match current owner facts',
  });

const readOrderStorefrontCurrent = Effect.fn('OrderFinalizationPricingContext.readStorefrontCurrent')(
  function* readStorefront(
    scope: OperationalScope,
    approved: Pick<PurchaseApprovalRequest, 'proposal'>,
    operationTime: string,
    compositionRevision: string,
  ) {
    const { legalEntityId } = scope;
    const crypto = yield* Crypto.Crypto;
    if (legalEntityId === undefined || approved.proposal.context.channelId !== 'B2B') {
      return yield* invalid();
    }
    const issue = Effect.fn('OrderFinalizationPricingContext.issueOwnerCredential')(function* issue(
      audience: 'storefront-registry' | 'commerce-market-catalog',
    ) {
      const issued = yield* acquireDelegatedGatewayContext(
        {
          audience,
          callingAppId: 'commerce-customer-context',
          legalEntityScope: 'subject',
          requestCorrelation: scope.correlationId,
          subject: { _tag: 'Assertion', scope },
        },
        crypto,
      ).pipe(Effect.mapError(unavailable));
      const now = yield* DateTime.now;
      if (
        issued.compositionRevision !== compositionRevision ||
        issued.expiresAt * 1000 <= DateTime.toEpochMillis(now)
      ) {
        return yield* unavailable('The owner credential is not current');
      }
      return { baseUrl: new URL(issued.apiBaseUrl), credential: issued.authorization };
    });
    const registryCredential = yield* issue('storefront-registry');
    const payload = yield* Schema.decodeUnknownEffect(CurrentStorefrontApplicationRequestSchema)({
      effectiveAt: operationTime,
      requestedChannel: 'B2B',
      storefrontAppId: approved.proposal.context.storefrontId,
      tenantId: scope.tenantId,
    }).pipe(Effect.mapError(unavailable));
    const registry = yield* executeCurrentStorefrontApplicationWithAuthorization(
      payload,
      registryCredential.credential,
      scope.correlationId,
      { baseUrl: registryCredential.baseUrl, compositionRevision },
    ).pipe(Effect.mapError(unavailable));
    if (
      registry.outcome !== 'CURRENT' ||
      registry.storefrontAppId !== payload.storefrontAppId ||
      registry.tenantId !== scope.tenantId ||
      registry.requestedChannel !== 'B2B' ||
      registry.effectiveAt !== operationTime
    ) {
      return yield* unavailable('The Storefront Registry cannot prove the current application');
    }
    const marketCredential = yield* issue('commerce-market-catalog');
    const market = yield* executeEligibleMarketTuplesWithAuthorization(
      {
        channel: 'B2B',
        effectiveAt: DateTime.makeUnsafe(operationTime),
        sellingLegalEntityRestriction: {
          moduleId: 'core.identity',
          resourceId: legalEntityId,
          resourceType: 'core.identity.legal-entity',
          tenantId: scope.tenantId,
        },
        storefrontRef: { appId: approved.proposal.context.storefrontId, tenantId: scope.tenantId },
      },
      marketCredential.credential,
      scope.correlationId,
      { baseUrl: marketCredential.baseUrl, compositionRevision },
    ).pipe(Effect.mapError(unavailable));
    if (
      market.outcome !== 'ELIGIBLE_MARKET_TUPLES' ||
      DateTime.toEpochMillis(market.effectiveAt) !== DateTime.toEpochMillis(DateTime.makeUnsafe(operationTime))
    ) {
      return yield* unavailable('The Commerce Market owner cannot prove the current Storefront tuple');
    }
    const matches = market.tuples.filter(
      (tuple) =>
        tuple.channel === 'B2B' &&
        tuple.marketRef.tenantId === scope.tenantId &&
        tuple.marketRef.resourceId === approved.proposal.context.marketId &&
        tuple.sellingLegalEntityRef.resourceId === legalEntityId &&
        tuple.sellingLegalEntityRef.tenantId === scope.tenantId,
    );
    if (matches.length !== 1) {
      return yield* invalid();
    }
    return {
      marketBoundary:
        market.nextApplicabilityBoundary === undefined
          ? undefined
          : DateTime.formatIso(market.nextApplicabilityBoundary),
      marketRevision: market.completenessEvidence.ownerRevision,
      registryBoundary: registry.nextApplicabilityBoundary,
      registryRevision: registry.ownerRevision,
      tuple: matches[0],
    };
  },
);

type PreproposalPricingBasis = Readonly<{
  materialHash: string;
  preproposal: true;
  proposal: PurchaseProposalRevision;
}>;

const purchasePricingContextBasis = (request: PurchaseApprovalRequest | PreproposalPricingBasis) =>
  Match.value(request).pipe(
    Match.when({ preproposal: true }, (basis) => ({
      authorized: true,
      contextIdentity: basis.proposal.proposalRevisionRef,
      contextPrefix: 'ccc:preproposal:',
      expiry: basis.proposal.expiresAt,
      materialHash: basis.materialHash,
    })),
    Match.orElse((approval) => ({
      authorized: approval.status === 'APPROVED',
      contextIdentity: approval.requestRef,
      contextPrefix,
      expiry: approval.expiresAt,
      materialHash: approval.proposal.canonicalHash,
    })),
  );

const proposalAdmitsPricingContext = ({
  at,
  basis,
  legalEntityId,
  proposal,
  scope,
}: {
  readonly at: number;
  readonly basis: ReturnType<typeof purchasePricingContextBasis>;
  readonly legalEntityId: string;
  readonly proposal: PurchaseProposalRevision;
  readonly scope: OperationalScope;
}): boolean =>
  basis.authorized &&
  proposal.state === 'CURRENT' &&
  proposal.context.channelId === 'B2B' &&
  proposal.context.tenantId === scope.tenantId &&
  proposal.context.sellingLegalEntityId === legalEntityId &&
  proposal.identity.buyer.tenantId === scope.tenantId &&
  basis.contextIdentity.tenantId === scope.tenantId &&
  at >= DateTime.toEpochMillis(proposal.createdAt) &&
  at < Math.min(DateTime.toEpochMillis(basis.expiry), DateTime.toEpochMillis(proposal.expiresAt)) &&
  computePurchaseProposalCanonicalHash(proposal) === proposal.canonicalHash;

/** SQL-only immutable owner facts. Remote authority never receives this executor. */
export const loadPurchasePricingContextSnapshot = Effect.fn('OrderFinalizationPricingContext.loadSnapshot')(
  function* loadSnapshot(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest | PreproposalPricingBasis,
    operationTime: string,
  ) {
    const { proposal } = approvedRequest;
    const { legalEntityId } = scope;
    const at = DateTime.toEpochMillis(DateTime.makeUnsafe(operationTime));
    if (
      legalEntityId === undefined ||
      !proposalAdmitsPricingContext({
        at,
        basis: purchasePricingContextBasis(approvedRequest),
        legalEntityId,
        proposal,
        scope,
      })
    ) {
      return yield* invalid();
    }
    const profileRef = yield* Schema.decodeUnknownEffect(CommerceCustomerProfileRefSchema)({
      ...proposal.identity.profileRef,
      kind: 'COUNTERPARTY',
    }).pipe(Effect.mapError(unavailable));
    const counterpartyRef = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema)(
      proposal.identity.counterpartyRef,
    ).pipe(Effect.mapError(unavailable));
    const profiles = profilePersistenceServicesForTransaction(transaction, { ...scope, legalEntityId });
    const profile = yield* profiles.customerProfileRead
      .readProfile(
        {
          authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
          profileRef,
        },
        scope.tenantId,
      )
      .pipe(Effect.mapError(unavailable));
    if (
      !Predicate.isTagged(profile, 'PROFILE_AVAILABLE') ||
      profile.profile.kind !== 'COUNTERPARTY' ||
      profile.profile.state !== 'ACTIVE' ||
      profile.profile.subject.counterpartyRef.resourceId !== counterpartyRef.resourceId
    ) {
      return yield* invalid();
    }
    const ownerAccess = yield* readOrderBuyerPermissionForVerifiedSubject(transaction, scope, proposal, {
      lock: !('preproposal' in approvedRequest),
    }).pipe(Effect.mapError(unavailable));
    if (ownerAccess !== 'ALLOWED') {
      return yield* invalid();
    }
    const assignments = yield* customerPriceGroupAssignmentStoreForTransaction(transaction, { ...scope, legalEntityId })
      .resolve(profileRef, operationTime)
      .pipe(Effect.mapError(unavailable));
    if (!Predicate.isTagged(assignments, 'found') || assignments.assignments.length !== 0) {
      return yield* unavailable('Assigned Price Group finalization requires its owner verification');
    }
    const repository = yield* customerCommercePolicyRepositoryForScope(transaction, scope);
    const paymentPolicy = yield* repository.loadPaymentTermPolicyState.pipe(Effect.mapError(unavailable));
    const currencyPolicy = yield* repository.loadPurchaseCurrencyPolicyState.pipe(Effect.mapError(unavailable));
    return {
      binding: stableRevision({ approvedRequest, operationTime, scope }),
      currencyPolicy,
      ownerAccess,
      paymentPolicy,
      profile,
    };
  },
);

/** Resolves Party, Pricing, Registry and Market authority after the owner load commits. */
export const resolvePurchasePricingContextFromSnapshot = Effect.fn('OrderFinalizationPricingContext.finishSnapshot')(
  function* finishSnapshot(
    scope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest | PreproposalPricingBasis,
    compositionRevision: string,
    operationTime: string,
    snapshot: Effect.Success<ReturnType<typeof loadPurchasePricingContextSnapshot>>,
  ) {
    const { proposal } = approvedRequest;
    const basis = purchasePricingContextBasis(approvedRequest);
    const { contextIdentity, expiry } = basis;
    const { legalEntityId } = scope;
    const at = DateTime.toEpochMillis(DateTime.makeUnsafe(operationTime));
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      legalEntityId === undefined ||
      at > now ||
      now - at > 30_000 ||
      snapshot.binding !== stableRevision({ approvedRequest, operationTime, scope }) ||
      !proposalAdmitsPricingContext({ at, basis, legalEntityId, proposal, scope })
    ) {
      return yield* invalid();
    }
    const { ownerAccess, paymentPolicy, profile } = snapshot;
    if (!Predicate.isTagged(profile, 'PROFILE_AVAILABLE') || profile.profile.kind !== 'COUNTERPARTY') {
      return yield* invalid();
    }
    const counterpartyRef = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema)(
      proposal.identity.counterpartyRef,
    ).pipe(Effect.mapError(unavailable));
    const subject = yield* Schema.decodeUnknownEffect(PurchaseCurrencySubjectSchema)({
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
      kind: 'PROFILE',
      profileRef: proposal.identity.profileRef,
    }).pipe(Effect.mapError(unavailable));
    const roleFactory = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const role = yield* roleFactory
      .make({
        legalEntityId,
        operationalScope: scope,
        requestCorrelation: scope.correlationId,
        tenantId: scope.tenantId,
      })({
        counterpartyResourceId: counterpartyRef.resourceId,
        tenantId: scope.tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    yield* assertPreparedCounterpartyRoleCurrent(role).pipe(Effect.mapError(unavailable));
    if (role.outcome !== 'ELIGIBLE' || role.managedLegalEntityId !== legalEntityId) {
      return yield* invalid();
    }
    const { buyer } = proposal.identity;
    const currencyRequest = yield* Schema.decodeUnknownEffect(PurchaseCurrencyResolutionRequestSchema)({
      contextRevision: String(profile.profile.revision),
      explicitChoice: proposal.currency,
      purchasingContext: {
        cartId: proposal.sourceCart.cartRef.resourceId,
        channelId: proposal.context.channelId,
        marketId: proposal.context.marketId,
        sellingLegalEntityId: legalEntityId,
        storefrontId: proposal.context.storefrontId,
        tenantId: scope.tenantId,
      },
      requestedAt: operationTime,
      subject,
    }).pipe(Effect.mapError(unavailable));
    const { policy, pricingPort } = yield* Effect.all(
      {
        policy: composeCurrentPurchaseCurrencyPolicy(
          currentPurchaseCurrencyPolicySet(snapshot.currencyPolicy, operationTime),
          currencyRequest.purchasingContext,
          operationTime,
        ).pipe(Effect.mapError(unavailable)),
        pricingPort: purchaseCurrencyPricingPortFromEnvironment({
          requestCorrelation: scope.correlationId,
          subject: { _tag: 'Assertion', scope },
        }),
      },
      { concurrency: 1 },
    );
    const pricing = yield* pricingPort
      .resolveCurrent({ effectiveAt: operationTime, tenantId: scope.tenantId })
      .pipe(Effect.mapError(unavailable));
    const currency = resolvePurchaseCurrency({ policy, pricing, request: currencyRequest });
    if (!Predicate.isTagged(currency, 'PURCHASE_CURRENCY_RESOLVED')) {
      return yield* invalid();
    }
    const storefront = yield* readOrderStorefrontCurrent(scope, approvedRequest, operationTime, compositionRevision);
    const contextRef = `${basis.contextPrefix}${contextIdentity.resourceId}`;
    const accessRevision = stableRevision({
      buyer,
      counterpartyRef,
      ownerAccess,
      permission: 'counterparty.purchase.submit',
      profileRevision: profile.profile.revision,
    });
    const roleFacts = [
      {
        resourceRef: role.roleResourceId,
        revision: role.roleResourceRevision,
        status: 'CURRENT',
      },
    ];
    const settingsRevision = stableRevision({
      paymentPolicy,
      priceGroupAssignments: [],
      profileRevision: profile.profile.revision,
      roleFacts,
    });
    const currencyRevision = stableRevision({
      currencyCode: currency.currencyCode,
      policyRevisionIds: policy.policyRevisionIds,
      pricingRevision: pricing.pricingRevision,
      scheduleRevision: pricing.scheduleRevision,
      supportRevisionRef: pricing.supportRevisionRef,
    });
    const contextRevision = stableRevision({
      accessRevision,
      currencyRevision,
      proposalHash: basis.materialHash,
      requestRef: contextIdentity,
      settingsRevision,
      storefront,
    });
    const context = yield* Schema.decodeUnknownEffect(OrderFinalizationPricingContextSchema)({
      commercialScope: {
        channelId: proposal.context.channelId,
        marketId: proposal.context.marketId,
        sellingLegalEntityId: legalEntityId,
      },
      currencyCode: currency.currencyCode,
      purchasingContext: {
        accessDecision: { decisionRef: `${contextRef}:access`, decisionRevision: accessRevision },
        actor: { kind: 'PRINCIPAL', principalId: buyer.principalId },
        commercialSettingsDecision: { decisionRef: `${contextRef}:settings`, decisionRevision: settingsRevision },
        contextRef,
        contextRevision,
        currencyResolution: {
          currencyCode: currency.currencyCode,
          resolutionRef: `${contextRef}:currency`,
          resolutionRevision: currencyRevision,
        },
        subject,
      },
      subject,
    }).pipe(Effect.mapError(unavailable));
    const boundaries = [
      policy.completeness.nextApplicabilityBoundary,
      pricing.nextApplicabilityBoundary,
      storefront.registryBoundary,
      storefront.marketBoundary,
    ].filter((value): value is string => value !== undefined);
    const validUntil = Math.min(
      at + 30_000,
      DateTime.toEpochMillis(DateTime.makeUnsafe(role.validUntil ?? operationTime)),
      DateTime.toEpochMillis(expiry),
      DateTime.toEpochMillis(proposal.expiresAt),
      ...boundaries.map((value) => DateTime.toEpochMillis(DateTime.makeUnsafe(value))),
    );
    yield* assertPreparedCounterpartyRoleCurrent(role).pipe(Effect.mapError(unavailable));
    if (DateTime.toEpochMillis(yield* DateTime.now) >= validUntil) {
      return yield* unavailable('The purchase context observation expired during remote resolution');
    }
    const subjectContext = yield* Schema.decodeUnknownEffect(PurchaseCurrencySubjectSchema)(context.subject).pipe(
      Effect.mapError(unavailable),
    );
    return {
      context: { ...context, subject: subjectContext },
      profileRevision: profile.profile.revision,
      storefront,
      validUntil,
    };
  },
);

export const loadOrderFinalizationPricingAuthoritySnapshot = Effect.fn(
  'OrderFinalizationPricingContext.loadAuthoritySnapshot',
)(function* loadAuthoritySnapshot(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  request: PricingPurchaseContextVerificationRequest,
) {
  const { legalEntityId } = scope;
  if (legalEntityId === undefined) {
    return yield* invalid();
  }
  // The Pricing module is the calling actor (DESIGN D6); the subject is the buyer the quotation prices for.
  const actor = readVerifiedGatewayActor(scope);
  if (
    actor?.appId !== 'pricing' ||
    !isVerifiedGatewayPrincipalContext(scope) ||
    scope.impersonatedByPrincipalId !== undefined ||
    request.tenantId !== scope.tenantId ||
    request.purchasingContext.sellingLegalEntityId !== legalEntityId
  ) {
    return yield* invalid();
  }
  // Installation is the module-state gate's fact, not a second permission check (O62).
  const requestId = request.purchasingContext.contextRef.slice(contextPrefix.length);
  if (
    !request.purchasingContext.contextRef.startsWith(contextPrefix) ||
    !Schema.is(Schema.String.check(Schema.isUUID()))(requestId)
  ) {
    return yield* invalid();
  }
  const [row] = yield* transaction
    .invoke(readCurrentPurchaseApprovalRevalidationRoutine, [
      {
        requestRef: {
          moduleId: MODULE_ID,
          resourceId: requestId,
          resourceType: 'commerce.customer-context.purchase-approval-request',
          tenantId: scope.tenantId,
        },
      },
    ])
    .pipe(Effect.mapError(unavailable));
  if (row === undefined) {
    return Option.none();
  }
  const { request: approved } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ request: PurchaseApprovalRequestSchema }),
  )(row.result).pipe(Effect.mapError(unavailable));
  if (
    approved.requestRef.resourceId !== requestId ||
    approved.requestRef.tenantId !== scope.tenantId ||
    scope.principalId !== approved.proposal.identity.buyer.principalId
  ) {
    return yield* invalid();
  }
  const pricing = yield* loadPurchasePricingContextSnapshot(transaction, scope, approved, request.operationTime);
  return Option.some({ approved, pricing });
});

export const finishOrderFinalizationPricingAuthority = Effect.fn('OrderFinalizationPricingContext.finishAuthority')(
  function* finishAuthority(
    scope: OperationalScope,
    request: PricingPurchaseContextVerificationRequest,
    compositionRevision: string,
    loaded: Effect.Success<ReturnType<typeof loadOrderFinalizationPricingAuthoritySnapshot>>,
  ) {
    if (Option.isNone(loaded)) {
      return Option.none();
    }
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* invalid();
    }
    const { approved, pricing } = loaded.value;
    const observation = yield* resolvePurchasePricingContextFromSnapshot(
      scope,
      approved,
      compositionRevision,
      request.operationTime,
      pricing,
    );
    const { context } = observation;
    if (
      request.actor.kind !== 'AUTHENTICATED_CUSTOMER' ||
      request.actor.principalId !== approved.proposal.identity.buyer.principalId ||
      !Schema.toEquivalence(PurchaseCurrencySubjectSchema)(request.subject, context.subject)
    ) {
      return yield* invalid();
    }
    const validFrom = request.operationTime;
    const validTo = DateTime.formatIso(DateTime.makeUnsafe(observation.validUntil));
    const observedAt = DateTime.formatIso(yield* DateTime.now);
    const actorPrincipalId = yield* Schema.decodeUnknownEffect(PrincipalIdSchema)(
      approved.proposal.identity.buyer.principalId,
    ).pipe(Effect.mapError(unavailable));
    const verifiedTenantId = yield* Schema.decodeUnknownEffect(TenantIdSchema)(scope.tenantId).pipe(
      Effect.mapError(unavailable),
    );
    return Option.some({
      actor: request.actor,
      evidence: {
        currentness: { evaluatedAt: request.operationTime, observedAt, validFrom, validTo },
        ownerRef: context.purchasingContext.contextRef,
        ownerRevisionRef: context.purchasingContext.contextRevision,
        subjectAuthority: {
          actorPrincipalId,
          kind: 'PROFILE' as const,
          partyAuthorityRef: approved.proposal.identity.counterpartyRef.resourceId,
          partyAuthorityRevisionRef: context.purchasingContext.commercialSettingsDecision.decisionRevision,
          subject: context.subject,
          subjectAuthorityRef: approved.proposal.identity.profileRef.resourceId,
          subjectAuthorityRevisionRef: context.purchasingContext.contextRevision,
        },
        verificationRef: `${context.purchasingContext.contextRef}:${context.purchasingContext.contextRevision}`,
        verifiedScope: {
          channelId: context.commercialScope.channelId,
          legalEntityId,
          marketId: context.commercialScope.marketId,
          tenantId: verifiedTenantId,
        },
      },
      legalEntityId,
      purchasingContext: {
        ...context.commercialScope,
        contextRef: context.purchasingContext.contextRef,
        contextRevision: context.purchasingContext.contextRevision,
      },
      subject: context.subject,
      tenantId: scope.tenantId,
    });
  },
);
