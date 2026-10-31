import { executeCurrentStorefrontApplicationWithAuthorization } from '@app/storefront-registry-contracts/current-storefront-application/client';
import { CurrentStorefrontApplicationRequestSchema } from '@app/storefront-registry-contracts/current-storefront-application';
import { executeEligibleMarketTuplesWithAuthorization } from '@app/commerce-market-catalog/api/client';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import { PurchaseLimitEvaluationCurrentFactsSchema } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseLimitDependencyUnavailableSchema } from '../../shared/domain/purchase-limit-policy.ts';
import type { PurchaseValue } from '../../shared/domain/purchase-limit.ts';
import {
  PrincipalIdSchema,
  TenantIdSchema,
  AuthenticationNamespaceIdSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { ContextAccess, isVerifiedGatewayPrincipalContext } from '@app/core-runtime';
import type { OperationalScope, ScopedRoutineInvoker, ScopedTransactionExecutor } from '@app/core-runtime';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Config, DateTime, Effect, Match, Option, Schema, Predicate } from 'effect';
import { Hex } from 'effect/encoding';
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
import { currentOwnerAccessForTransaction } from '../persistence/access-persistence.ts';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../profile-counterparty-role-eligibility.ts';
import { customerCommercePolicyRepositoryForScope } from '../persistence/customer-commerce-policy-persistence.ts';
import { customerPriceGroupAssignmentStoreForTransaction } from '../persistence/price-group-persistence.ts';
import { readCurrentPurchaseApprovalRevalidationRoutine } from '../persistence/purchasing-approval-persistence.ts';
import { profileServicesForVerifiedScope } from '../profile-service-factory.ts';
import { purchaseCurrencyPolicyPortForRepository } from './purchase-currency-policy.ts';
import { purchaseCurrencyPricingPortFromEnvironment } from './purchase-currency-pricing.ts';
import {
  PricingPurchaseContextOwnerUnavailable,
  PricingPurchaseContextOwnerUnverifiable,
} from '../services/pricing-purchase-context-owner-authority.ts';
import type { PricingPurchaseContextOwnerAuthorityPort } from '../services/pricing-purchase-context-owner-authority.ts';

const contextPrefix = 'ccc:order-finalization:';
const MODULE_ID = 'commerce.customer-context' as const;
const PURCHASE_PERMISSION = 'counterparty.purchase.submit' as const;
const encodeScalarOption = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
/** Values JSON cannot carry (`undefined`, functions, symbols) render as `null`, exactly as before. */
const encodeScalar = <Value>(value: Value) => Option.getOrElse(encodeScalarOption(value), () => 'null');
/** Structural, key-order independent rendering of any owner document; the hashed shape is the caller's. */
const canonical = <Document>(value: Document): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (Predicate.isObjectKeyword(value)) {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${encodeScalar(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return encodeScalar(value);
};
export const stableRevision = <Document>(value: Document) => Hex.encode(sha256(utf8ToBytes(canonical(value))));
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

const ownerGatewayConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  shellBaseUrl: Config.schema(
    Schema.URLFromString.check(
      Schema.makeFilter((url) =>
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
          ? undefined
          : 'Expected a trusted HTTP service URL',
      ),
    ),
    'ONTOS_SHELL_GATEWAY_BASE_URL',
  ),
});

const readOrderStorefrontCurrent = Effect.fn('OrderFinalizationPricingContext.readStorefrontCurrent')(
  function* readStorefront(
    scope: OperationalScope,
    approved: Pick<PurchaseApprovalRequest, 'proposal'>,
    operationTime: string,
    compositionRevision: string,
  ) {
    const configured = yield* ownerGatewayConfiguration.pipe(Effect.mapError(unavailable));
    const { legalEntityId } = scope;
    if (legalEntityId === undefined || approved.proposal.context.channelId !== 'B2B') {
      return yield* invalid();
    }
    const issue = Effect.fn('OrderFinalizationPricingContext.issueOwnerCredential')(function* issue(
      audience: 'storefront-registry' | 'commerce-market-catalog',
    ) {
      const issued = yield* issueApiKeyGatewayContext(
        { audience, compositionRevision, legalEntityId },
        { apiKey: configured.apiKey, baseUrl: configured.shellBaseUrl, requestCorrelation: scope.correlationId },
      ).pipe(Effect.mapError(unavailable));
      const now = yield* DateTime.now;
      if (
        issued.compositionRevision !== compositionRevision ||
        issued.expiresAt * 1000 <= DateTime.toEpochMillis(now)
      ) {
        return yield* unavailable('The owner credential is not current');
      }
      return { baseUrl: new URL(issued.apiBaseUrl, configured.shellBaseUrl), credential: `Bearer ${issued.token}` };
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

/** Called only after the service entrypoint admits the actual Cart/Order service principal. */
export const loadPurchasePricingContextSnapshot = Effect.fn('OrderFinalizationPricingContext.loadSnapshot')(
  function* resolve(
    transaction: ScopedRoutineInvoker,
    scope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest | PreproposalPricingBasis,
    operationTime: string,
  ) {
    const { proposal } = approvedRequest;
    const basis = purchasePricingContextBasis(approvedRequest);
    const { legalEntityId } = scope;
    const at = DateTime.toEpochMillis(DateTime.makeUnsafe(operationTime));
    const now = yield* DateTime.now;
    if (at > DateTime.toEpochMillis(now) || DateTime.toEpochMillis(now) - at > 30_000) {
      return yield* invalid();
    }
    if (legalEntityId === undefined || !proposalAdmitsPricingContext({ at, basis, legalEntityId, proposal, scope })) {
      return yield* invalid();
    }
    const profileRef = yield* Schema.decodeUnknownEffect(CommerceCustomerProfileRefSchema)({
      ...proposal.identity.profileRef,
      kind: 'COUNTERPARTY',
    }).pipe(Effect.mapError(unavailable));
    const counterpartyRef = yield* Schema.decodeUnknownEffect(CounterpartyRefSchema)(
      proposal.identity.counterpartyRef,
    ).pipe(Effect.mapError(unavailable));
    const subject = yield* Schema.decodeUnknownEffect(PurchaseCurrencySubjectSchema)({
      authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
      kind: 'PROFILE',
      profileRef: proposal.identity.profileRef,
    }).pipe(Effect.mapError(unavailable));
    const profiles = yield* profileServicesForVerifiedScope(transaction, scope).pipe(Effect.mapError(unavailable));
    const profileInput = { authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' as const }, profileRef };
    const profile = yield* profiles.customerProfileRead
      .readProfile(profileInput, scope.tenantId)
      .pipe(Effect.mapError(unavailable));
    if (
      !Predicate.isTagged(profile, 'PROFILE_AVAILABLE') ||
      profile.profile.kind !== 'COUNTERPARTY' ||
      profile.profile.state !== 'ACTIVE' ||
      profile.profile.subject.counterpartyRef.resourceId !== counterpartyRef.resourceId
    ) {
      return yield* invalid();
    }
    const ownerAccess = yield* currentOwnerAccessForTransaction(transaction, {
      legalEntityId,
      tenantId: counterpartyRef.tenantId,
    })({
      counterpartyRef,
      legalEntityId,
      permission: PURCHASE_PERMISSION,
      principal: proposal.identity.buyer,
      scope: { kind: 'storefront', storefrontKey: proposal.context.storefrontId },
    }).pipe(Effect.mapError(unavailable));
    if (ownerAccess !== 'ALLOWED') {
      return yield* invalid();
    }
    const scoped = { ...scope, legalEntityId };
    const assignments = yield* customerPriceGroupAssignmentStoreForTransaction(transaction, scoped)
      .resolve(profileRef, operationTime)
      .pipe(Effect.mapError(unavailable));
    if (!Predicate.isTagged(assignments, 'found') || assignments.assignments.length !== 0) {
      return yield* unavailable('Assigned Price Group finalization requires its owner verification');
    }
    const repository = yield* customerCommercePolicyRepositoryForScope(transaction, scope);
    const paymentPolicy = yield* repository.loadPaymentTermPolicyState.pipe(Effect.mapError(unavailable));
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
    const currencyPolicy = yield* repository.loadPurchaseCurrencyPolicyState.pipe(Effect.mapError(unavailable));
    const policy = yield* purchaseCurrencyPolicyPortForRepository({
      loadPurchaseCurrencyPolicyState: Effect.succeed(currencyPolicy),
    })
      .resolveCurrent({ context: currencyRequest, observedAt: operationTime, subject })
      .pipe(Effect.mapError(unavailable));
    return {
      assignments: assignments.assignments,
      currencyPolicy,
      currencyRequest,
      ownerAccess,
      paymentPolicy,
      policy,
      profile: profile.profile,
      subject,
    };
  },
);

export type PurchasePricingContextSnapshot = Effect.Success<ReturnType<typeof loadPurchasePricingContextSnapshot>>;

/** Runs only after the SQL snapshot has committed. No scoped persistence service escapes load. */
export const resolvePurchasePricingContextFromSnapshot = Effect.fn('OrderFinalizationPricingContext.resolveSnapshot')(
  function* resolveSnapshot(
    scope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest | PreproposalPricingBasis,
    compositionRevision: string,
    operationTime: string,
    snapshot: PurchasePricingContextSnapshot,
  ) {
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* invalid();
    }
    const { proposal } = approvedRequest;
    const basis = purchasePricingContextBasis(approvedRequest);
    const { contextIdentity, expiry } = basis;
    const at = DateTime.toEpochMillis(DateTime.makeUnsafe(operationTime));
    const { currencyRequest, ownerAccess, paymentPolicy, policy, profile, subject } = snapshot;
    const { buyer } = proposal.identity;
    const access = yield* ContextAccess;
    if (access.businessPermissions === undefined) {
      return yield* unavailable('Core buyer authorization is unavailable');
    }
    const [permission] = yield* access.businessPermissions({
      principal: buyer,
      targets: [
        {
          permission: PURCHASE_PERMISSION,
          target: {
            counterpartyId: proposal.identity.counterpartyRef.resourceId,
            kind: 'counterparty_storefront',
            legalEntityId,
            storefrontId: proposal.context.storefrontId,
            tenantId: scope.tenantId,
          },
        },
      ],
      trustedStorefrontId: proposal.context.storefrontId,
    });
    if (permission?.decision !== 'allowed') {
      return yield* invalid();
    }
    const roles = yield* ProfileCounterpartyRoleEligibilityResolverFactory;
    const role = yield* roles
      .make({ legalEntityId, requestCorrelation: scope.correlationId, tenantId: scope.tenantId })({
        counterpartyResourceId: proposal.identity.counterpartyRef.resourceId,
        tenantId: scope.tenantId,
      })
      .pipe(Effect.mapError(unavailable));
    if (role.outcome !== 'ELIGIBLE' || role.managedLegalEntityId !== legalEntityId) {
      return yield* invalid();
    }
    const roleFacts = [{ resourceRef: role.roleResourceId, revision: role.roleResourceRevision, status: 'CURRENT' }];
    const pricingPort = yield* purchaseCurrencyPricingPortFromEnvironment({
      compositionRevision,
      legalEntityId,
      requestCorrelation: scope.correlationId,
    });
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
      counterpartyRef: proposal.identity.counterpartyRef,
      ownerAccess,
      permission: PURCHASE_PERMISSION,
      profileRevision: profile.revision,
    });
    const settingsRevision = stableRevision({
      paymentPolicy,
      priceGroupAssignments: [],
      profileRevision: profile.revision,
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
      DateTime.toEpochMillis(expiry),
      DateTime.toEpochMillis(proposal.expiresAt),
      ...boundaries.map((value) => DateTime.toEpochMillis(DateTime.makeUnsafe(value))),
    );
    const subjectContext = yield* Schema.decodeUnknownEffect(PurchaseCurrencySubjectSchema)(context.subject).pipe(
      Effect.mapError(unavailable),
    );
    if (DateTime.toEpochMillis(yield* DateTime.now) >= validUntil) {
      return yield* unavailable('The owner pricing snapshot expired during dependency resolution');
    }
    return {
      context: { ...context, subject: subjectContext },
      profileRevision: profile.revision,
      storefront,
      validUntil,
    };
  },
);

/** Action callers must use an invocation-local preflight before entering their commit transaction. */
export const resolvePurchasePricingContextObservation = Effect.fn('OrderFinalizationPricingContext.resolveObservation')(
  function* resolveObservation(
    transaction: ScopedRoutineInvoker,
    scope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest | PreproposalPricingBasis,
    compositionRevision: string,
    operationTime: string,
  ) {
    const snapshot = yield* loadPurchasePricingContextSnapshot(transaction, scope, approvedRequest, operationTime);
    return yield* resolvePurchasePricingContextFromSnapshot(
      scope,
      approvedRequest,
      compositionRevision,
      operationTime,
      snapshot,
    );
  },
);

const resolveOrderFinalizationPricingContextObservation = resolvePurchasePricingContextObservation;

export const resolveOrderFinalizationPricingContext = Effect.fn('OrderFinalizationPricingContext.resolve')(
  function* resolve(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest,
    compositionRevision: string,
    operationTime: string,
  ) {
    const observation = yield* resolveOrderFinalizationPricingContextObservation(
      transaction,
      scope,
      approvedRequest,
      compositionRevision,
      operationTime,
    );
    return observation.context;
  },
);

const pricingServiceGrants = Config.schema(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        authenticationNamespaceId: AuthenticationNamespaceIdSchema,
        legalEntityId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId')),
        principalId: PrincipalIdSchema,
        role: Schema.Literal('PRICING_SERVICE'),
        tenantId: TenantIdSchema,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  ),
  'ONTOS_CCC_PRICING_FINALIZATION_SERVICE_GRANTS',
);

type PricingAuthorityRequest = Parameters<PricingPurchaseContextOwnerAuthorityPort['readCurrent']>[0];

export const loadOrderPricingAuthoritySnapshot = Effect.fn('OrderFinalizationPricingContext.loadAuthoritySnapshot')(
  function* loadAuthoritySnapshot(
    transaction: ScopedRoutineInvoker,
    scope: OperationalScope,
    input: PricingAuthorityRequest,
  ) {
    const { callingPrincipalId, legalEntityId, request, trustedTenantId } = input;
    const allowed = yield* pricingServiceGrants.pipe(Effect.mapError(unavailable));
    if (
      scope.authMethod !== 'api_key' ||
      !isVerifiedGatewayPrincipalContext(scope) ||
      scope.impersonatedByPrincipalId !== undefined ||
      scope.principalId !== callingPrincipalId ||
      scope.tenantId !== trustedTenantId ||
      scope.legalEntityId !== legalEntityId ||
      allowed.filter(
        (grant) =>
          grant.principalId === scope.principalId &&
          grant.authenticationNamespaceId === scope.authenticationNamespaceId &&
          grant.tenantId === scope.tenantId &&
          grant.legalEntityId === scope.legalEntityId,
      ).length !== 1
    ) {
      return yield* invalid();
    }
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
    if (approved.requestRef.resourceId !== requestId || approved.requestRef.tenantId !== scope.tenantId) {
      return yield* invalid();
    }
    const snapshot = yield* loadPurchasePricingContextSnapshot(transaction, scope, approved, request.operationTime);
    return Option.some({ approved, snapshot });
  },
);

export const finishOrderPricingAuthoritySnapshot = Effect.fn('OrderFinalizationPricingContext.finishAuthoritySnapshot')(
  function* finishAuthoritySnapshot(
    scope: OperationalScope,
    compositionRevision: string,
    input: PricingAuthorityRequest,
    loaded: Effect.Success<ReturnType<typeof loadOrderPricingAuthoritySnapshot>>,
  ) {
    if (Option.isNone(loaded)) {
      return Option.none();
    }
    const { legalEntityId, request } = input;
    const { approved, snapshot } = loaded.value;
    const access = yield* ContextAccess;
    const modules = yield* access.modules({
      legalEntityId,
      moduleIds: [MODULE_ID],
      principalId: scope.principalId,
      tenantId: scope.tenantId,
    });
    if (modules.length !== 1 || modules[0]?.key !== MODULE_ID || modules[0].decision !== 'allowed') {
      return yield* invalid();
    }
    const observation = yield* resolvePurchasePricingContextFromSnapshot(
      scope,
      approved,
      compositionRevision,
      request.operationTime,
      snapshot,
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

/** Real owner observations for the service-only revalidation port. No expected vector is read. */
export const resolveOrderCurrentnessFacts = Effect.fn('OrderFinalizationPricingContext.currentnessFacts')(
  function* currentnessFacts(
    transaction: ScopedTransactionExecutor,
    actualScope: OperationalScope,
    approvedRequest: PurchaseApprovalRequest,
    bundlePurchaseValue: PurchaseValue,
    observedAt: DateTime.Utc,
    compositionRevision: string,
  ) {
    const facts = yield* Effect.gen(function* loadFacts() {
      const [row] = yield* transaction.invoke(readCurrentPurchaseApprovalRevalidationRoutine, [
        { requestRef: approvedRequest.requestRef },
      ]);
      if (row === undefined) {
        return yield* invalid();
      }
      const { request: current } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ request: PurchaseApprovalRequestSchema }),
      )(row.result);
      if (
        current.requestRef.resourceId !== approvedRequest.requestRef.resourceId ||
        current.proposal.canonicalHash !== approvedRequest.proposal.canonicalHash ||
        computePurchaseProposalCanonicalHash(current.proposal) !== current.proposal.canonicalHash
      ) {
        return yield* invalid();
      }
      const operationTime = DateTime.formatIso(observedAt);
      const { context, profileRevision, storefront } = yield* resolveOrderFinalizationPricingContextObservation(
        transaction,
        actualScope,
        current,
        compositionRevision,
        operationTime,
      );
      return yield* Schema.decodeUnknownEffect(PurchaseLimitEvaluationCurrentFactsSchema)({
        channelId: context.commercialScope.channelId,
        contextRevision: context.purchasingContext.contextRevision,
        currentSourceRevisions: [
          {
            revision: stableRevision({
              currency: context.purchasingContext.currencyResolution.resolutionRevision,
              settings: context.purchasingContext.commercialSettingsDecision.decisionRevision,
            }),
            source: 'customer-commerce-policy',
          },
          { revision: current.proposal.purchaseValue.sourceRevision, source: 'purchase-proposal' },
          { revision: String(profileRevision), source: 'purchasing-profile' },
          { revision: stableRevision(storefront), source: 'storefront-context' },
        ],
        marketId: context.commercialScope.marketId,
        purchaseValue: bundlePurchaseValue,
      });
    }).pipe(
      Effect.mapError((cause) =>
        Object.defineProperty(
          PurchaseLimitDependencyUnavailableSchema.make({
            code: 'purchase_limit_dependency_unavailable',
            dependency: 'ORDER_FINALIZATION_CURRENTNESS',
            reason: 'Current Order source facts cannot be proven',
          }),
          'cause',
          { value: cause },
        ),
      ),
    );
    return facts;
  },
);
