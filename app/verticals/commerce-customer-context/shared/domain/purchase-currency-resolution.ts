import { CurrentSupportedCurrenciesSuccessSchema } from '@app/pricing-contracts/current-supported-currencies';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import { DateTime, Schema } from 'effect';
import {
  CustomerProfileRefSchema,
  PurchaseCurrencyAuthorizationSubjectSchema,
  isPurchaseCurrencyAuthorizationSubjectCompatible,
} from './customer-profile-ref.ts';
import { CurrencyCodeSchema, CurrencyCodeSetSchema } from './currency.ts';
import type { CurrencyCode } from './currency.ts';
import { ProfileInstantSchema } from './profile-contracts.ts';

const StableReferenceSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ChannelIdSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyChannelId'),
  Schema.decodeTo(Schema.String),
);
const CartIdSchema = StableReferenceSchema.pipe(Schema.brand('PurchaseCurrencyCartId'), Schema.decodeTo(Schema.String));
const GuestEvidenceRefSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyGuestEvidenceRef'),
  Schema.decodeTo(Schema.String),
);
const GuestSessionRefSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyGuestSessionRef'),
  Schema.decodeTo(Schema.String),
);
const MarketIdSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyMarketId'),
  Schema.decodeTo(Schema.String),
);
const SellingLegalEntityIdSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencySellingLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const StorefrontIdSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyStorefrontId'),
  Schema.decodeTo(Schema.String),
);
const TenantIdSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyTenantId'),
  Schema.decodeTo(Schema.String),
);
const ContextRevisionSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyContextRevision'),
  Schema.decodeTo(Schema.String),
);
const PolicyRevisionSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyPolicyRevision'),
  Schema.decodeTo(Schema.String),
);

export const PurchaseCurrencySubjectSchema = Schema.Union([
  Schema.Struct({
    guestEvidenceRef: GuestEvidenceRefSchema,
    guestSessionRef: GuestSessionRefSchema,
    kind: Schema.Literal('GUEST'),
  }),
  Schema.Struct({
    authorizationSubject: PurchaseCurrencyAuthorizationSubjectSchema,
    kind: Schema.Literal('PROFILE'),
    profileRef: CustomerProfileRefSchema,
  }),
]);
export type PurchaseCurrencySubject = typeof PurchaseCurrencySubjectSchema.Type;

export const PurchaseCurrencyResolutionRequestSchema = Schema.Struct({
  contextRevision: ContextRevisionSchema,
  explicitChoice: Schema.optionalKey(CurrencyCodeSchema),
  purchasingContext: Schema.Struct({
    cartId: CartIdSchema,
    channelId: ChannelIdSchema,
    marketId: MarketIdSchema,
    sellingLegalEntityId: SellingLegalEntityIdSchema,
    storefrontId: StorefrontIdSchema,
    tenantId: TenantIdSchema,
  }),
  requestedAt: ProfileInstantSchema,
  subject: PurchaseCurrencySubjectSchema,
}).check(
  Schema.makeFilter(({ purchasingContext, subject }) =>
    subject.kind === 'GUEST' ||
    (subject.profileRef.tenantId === purchasingContext.tenantId &&
      isPurchaseCurrencyAuthorizationSubjectCompatible(subject.profileRef, subject.authorizationSubject))
      ? undefined
      : 'The purchase subject must identify an exact compatible profile in the purchasing Tenant',
  ),
);
export type PurchaseCurrencyResolutionRequest = typeof PurchaseCurrencyResolutionRequestSchema.Type;

const PurchaseCurrencyPolicyCompletenessEvidenceSchema = Schema.toEncoded(
  OwnerVerifiableSetCompletenessEvidenceSchema,
).check(
  Schema.makeFilter((evidence) =>
    evidence.ownerRevision.startsWith('PURCHASE_CURRENCY:') &&
    evidence.scope.predicateRef === 'commerce.customer-context.policy.purchase_currency.current'
      ? undefined
      : 'Completeness evidence must identify the Current Purchase Currency policy field',
  ),
);

const CurrencyPolicyDecisionSchema = Schema.Struct({
  allowedCurrencies: CurrencyCodeSetSchema,
  completeness: PurchaseCurrencyPolicyCompletenessEvidenceSchema,
  defaultCurrency: Schema.Union([CurrencyCodeSchema, Schema.Null]),
  policyRevisionIds: Schema.Array(PolicyRevisionSchema).check(
    Schema.isMinLength(1),
    Schema.makeFilter((revisionIds) =>
      new Set(revisionIds).size === revisionIds.length ? undefined : 'Policy revision IDs must be unique',
    ),
  ),
});
export type CurrencyPolicyDecision = typeof CurrencyPolicyDecisionSchema.Type;

const currentPricingSupportFields = CurrentSupportedCurrenciesSuccessSchema.fields;
const instantFallsInPeriod = (instant: number, effectiveFrom: number, effectiveTo: number | undefined): boolean =>
  instant >= effectiveFrom && (effectiveTo === undefined || instant < effectiveTo);

const pricingSupportTemporalEvidenceIsValid = (support: {
  readonly currentnessEvidence: typeof currentPricingSupportFields.currentnessEvidence.Type;
  readonly effectiveAt: typeof currentPricingSupportFields.effectiveAt.Type;
  readonly effectivePeriod: typeof currentPricingSupportFields.effectivePeriod.Type;
  readonly nextApplicabilityBoundary?: typeof currentPricingSupportFields.nextApplicabilityBoundary.Type;
}): boolean => {
  const evaluationBindsRequest =
    support.currentnessEvidence.evaluationMode === 'HISTORICAL_AS_OF'
      ? support.currentnessEvidence.evaluatedAt === support.effectiveAt
      : support.effectiveAt <= support.currentnessEvidence.evaluatedAt;
  const effectiveAt = DateTime.toEpochMillis(DateTime.makeUnsafe(support.effectiveAt));
  const evaluatedAt = DateTime.toEpochMillis(DateTime.makeUnsafe(support.currentnessEvidence.evaluatedAt));
  const effectiveFrom = DateTime.toEpochMillis(DateTime.makeUnsafe(support.effectivePeriod.effectiveFrom));
  const effectiveTo =
    support.effectivePeriod.effectiveTo === null
      ? undefined
      : DateTime.toEpochMillis(DateTime.makeUnsafe(support.effectivePeriod.effectiveTo));
  const nextBoundary =
    support.nextApplicabilityBoundary === undefined
      ? undefined
      : DateTime.toEpochMillis(DateTime.makeUnsafe(support.nextApplicabilityBoundary));
  return (
    evaluationBindsRequest &&
    instantFallsInPeriod(effectiveAt, effectiveFrom, effectiveTo) &&
    instantFallsInPeriod(evaluatedAt, effectiveFrom, effectiveTo) &&
    (nextBoundary === undefined || evaluatedAt < nextBoundary)
  );
};

export const PricingCurrencySupportSchema = Schema.Struct({
  completenessEvidence: currentPricingSupportFields.completenessEvidence,
  currentnessEvidence: currentPricingSupportFields.currentnessEvidence,
  effectiveAt: currentPricingSupportFields.effectiveAt,
  effectivePeriod: currentPricingSupportFields.effectivePeriod,
  factProofs: currentPricingSupportFields.factProofs,
  generation: currentPricingSupportFields.generation,
  nextApplicabilityBoundary: currentPricingSupportFields.nextApplicabilityBoundary,
  observedAt: currentPricingSupportFields.observedAt,
  pricingRevision: currentPricingSupportFields.pricingRevision,
  scheduleRevision: currentPricingSupportFields.scheduleRevision,
  supportedCurrencies: currentPricingSupportFields.supportedCurrencies,
  supportRevisionRef: currentPricingSupportFields.supportRevisionRef,
  supportRootRef: currentPricingSupportFields.supportRootRef,
  tenantId: currentPricingSupportFields.tenantId,
  verificationRef: currentPricingSupportFields.verificationRef,
}).check(
  Schema.makeFilter((support) => {
    const rootId = support.supportRootRef.resourceId;
    const revisionId = support.supportRevisionRef.resourceId;
    if (
      support.supportRootRef.tenantId !== support.tenantId ||
      support.supportRevisionRef.tenantId !== support.tenantId ||
      support.supportRevisionRef.supportRootId !== rootId
    ) {
      return 'Pricing Currency Support evidence must bind one Tenant support root';
    }
    if (
      support.completenessEvidence.ownerRevision !== revisionId ||
      support.completenessEvidence.observedAt !== support.observedAt ||
      support.completenessEvidence.nextApplicabilityBoundary !== support.nextApplicabilityBoundary
    ) {
      return 'Pricing Currency Support completeness evidence must bind the exact observed Revision';
    }
    const [factProof] = support.factProofs;
    if (
      factProof === undefined ||
      factProof.factRef !== rootId ||
      factProof.factRevisionRef !== revisionId ||
      factProof.verificationRef !== support.verificationRef
    ) {
      return 'Pricing Currency Support fact proof must bind the exact root, Revision, and owner receipt';
    }
    if (
      support.currentnessEvidence.supportRootRef.resourceId !== rootId ||
      support.currentnessEvidence.supportRevisionRef.resourceId !== revisionId ||
      support.currentnessEvidence.scheduleRevision !== support.scheduleRevision ||
      support.currentnessEvidence.observedAt !== support.observedAt
    ) {
      return 'Pricing Currency Support currentness evidence must bind the exact evaluation';
    }
    return pricingSupportTemporalEvidenceIsValid(support)
      ? undefined
      : 'Pricing Currency Support request and owner evaluation must fall inside the proven interval';
  }),
);
export type PricingCurrencySupport = typeof PricingCurrencySupportSchema.Type;

const resolutionEvidenceFields = {
  contextRevision: ContextRevisionSchema,
  policyCompleteness: PurchaseCurrencyPolicyCompletenessEvidenceSchema,
  policyRevisionIds: Schema.Array(PolicyRevisionSchema).check(Schema.isMinLength(1)),
  pricingSupport: PricingCurrencySupportSchema,
  requestedAt: ProfileInstantSchema,
} as const;

export const PurchaseCurrencyResolvedSchema = Schema.TaggedStruct('PURCHASE_CURRENCY_RESOLVED', {
  currencyCode: CurrencyCodeSchema,
  evidence: Schema.Struct({
    ...resolutionEvidenceFields,
  }),
  source: Schema.Literals(['EXPLICIT_CHOICE', 'POLICY_DEFAULT']),
});
type PurchaseCurrencyResolved = typeof PurchaseCurrencyResolvedSchema.Type;

export const ExplicitPurchaseCurrencyChoiceInvalid = Schema.TaggedStruct('EXPLICIT_CHOICE_INVALID', {
  currencyCode: CurrencyCodeSchema,
  reason: Schema.Literals(['POLICY_UNSUPPORTED', 'PRICING_UNSUPPORTED']),
});

export const NoUsablePurchaseCurrency = Schema.TaggedStruct('NO_USABLE_CURRENCY', {
  reason: Schema.String,
});

export const InconsistentPurchaseCurrencyPolicy = Schema.TaggedStruct('INCONSISTENT_CURRENCY_POLICY', {
  reason: Schema.String,
});

export const PurchaseCurrencyResolutionFailureSchema = Schema.Union([
  ExplicitPurchaseCurrencyChoiceInvalid,
  NoUsablePurchaseCurrency,
  InconsistentPurchaseCurrencyPolicy,
]);
export type PurchaseCurrencyResolutionFailure = typeof PurchaseCurrencyResolutionFailureSchema.Type;

const PurchaseCurrencyResolutionOutcomeSchema = Schema.Union([
  PurchaseCurrencyResolvedSchema,
  PurchaseCurrencyResolutionFailureSchema,
]);
export type PurchaseCurrencyResolutionOutcome = typeof PurchaseCurrencyResolutionOutcomeSchema.Type;

export interface PurchaseCurrencyResolutionInput {
  readonly policy: CurrencyPolicyDecision;
  readonly pricing: PricingCurrencySupport;
  readonly request: PurchaseCurrencyResolutionRequest;
}

/** Current owner facts acquired behind the governed Read; never accepted from a caller. */
export interface PurchaseCurrencyCurrentFacts {
  readonly contextRevision: PurchaseCurrencyResolutionRequest['contextRevision'];
  readonly policy: CurrencyPolicyDecision;
  readonly pricing: PricingCurrencySupport;
  readonly purchasingContext: PurchaseCurrencyResolutionRequest['purchasingContext'];
  readonly subject: PurchaseCurrencySubject;
}

const supported = (
  code: CurrencyCode,
  policy: CurrencyPolicyDecision,
  pricing: PricingCurrencySupport,
): 'POLICY_UNSUPPORTED' | 'PRICING_UNSUPPORTED' | 'SUPPORTED' => {
  if (!policy.allowedCurrencies.includes(code)) {
    return 'POLICY_UNSUPPORTED';
  }
  return pricing.supportedCurrencies.includes(code) ? 'SUPPORTED' : 'PRICING_UNSUPPORTED';
};

const evidence = (input: PurchaseCurrencyResolutionInput) => ({
  contextRevision: input.request.contextRevision,
  policyCompleteness: input.policy.completeness,
  policyRevisionIds: input.policy.policyRevisionIds,
  pricingSupport: input.pricing,
  requestedAt: input.request.requestedAt,
});

const resolved = (
  input: PurchaseCurrencyResolutionInput,
  currencyCode: CurrencyCode,
  source: PurchaseCurrencyResolved['source'],
): PurchaseCurrencyResolved => ({
  _tag: 'PURCHASE_CURRENCY_RESOLVED',
  currencyCode,
  evidence: evidence(input),
  source,
});

export const resolvePurchaseCurrency = (input: PurchaseCurrencyResolutionInput): PurchaseCurrencyResolutionOutcome => {
  const { policy, pricing, request } = input;
  if (
    new Set(policy.allowedCurrencies).size !== policy.allowedCurrencies.length ||
    new Set(pricing.supportedCurrencies).size !== pricing.supportedCurrencies.length ||
    policy.allowedCurrencies.length === 0 ||
    (policy.defaultCurrency !== null && !policy.allowedCurrencies.includes(policy.defaultCurrency))
  ) {
    return InconsistentPurchaseCurrencyPolicy.make({
      reason: 'Currency policy contains duplicates or a default outside its supported set',
    });
  }

  if (request.explicitChoice !== undefined) {
    const support = supported(request.explicitChoice, policy, pricing);
    return support === 'SUPPORTED'
      ? resolved(input, request.explicitChoice, 'EXPLICIT_CHOICE')
      : ExplicitPurchaseCurrencyChoiceInvalid.make({
          currencyCode: request.explicitChoice,
          reason: support,
        });
  }

  if (policy.defaultCurrency !== null) {
    const support = supported(policy.defaultCurrency, policy, pricing);
    if (support === 'SUPPORTED') {
      return resolved(input, policy.defaultCurrency, 'POLICY_DEFAULT');
    }
  }

  return NoUsablePurchaseCurrency.make({
    reason: 'No explicit choice or valid unambiguous policy default exists',
  });
};
