import { Schema } from 'effect';
import {
  CustomerProfileRefSchema,
  PurchaseCurrencyAuthorizationSubjectSchema,
  isPurchaseCurrencyAuthorizationSubjectCompatible,
} from './customer-profile-ref.ts';
import { AKROS_LAUNCH_CURRENCY, CurrencyCodeSchema, CurrencyCodeSetSchema } from './currency.ts';
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
const PricingRevisionSchema = StableReferenceSchema.pipe(
  Schema.brand('PurchaseCurrencyPricingRevision'),
  Schema.decodeTo(Schema.String),
);

const PurchaseCurrencySubjectSchema = Schema.Union([
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

const CurrencyPolicyDecisionSchema = Schema.Struct({
  defaultCurrency: Schema.Union([CurrencyCodeSchema, Schema.Null]),
  explicitChoiceEnabled: Schema.Boolean,
  policyRevision: PolicyRevisionSchema,
  supportedCurrencies: CurrencyCodeSetSchema,
});
export type CurrencyPolicyDecision = typeof CurrencyPolicyDecisionSchema.Type;

const PricingCurrencySupportSchema = Schema.Struct({
  pricingRevision: PricingRevisionSchema,
  supportedCurrencies: CurrencyCodeSetSchema,
});
export type PricingCurrencySupport = typeof PricingCurrencySupportSchema.Type;

const resolutionEvidenceFields = {
  contextRevision: ContextRevisionSchema,
  policyRevision: PolicyRevisionSchema,
  pricingRevision: PricingRevisionSchema,
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
  reason: Schema.Literals(['EXPLICIT_CHOICE_DISABLED', 'POLICY_UNSUPPORTED', 'PRICING_UNSUPPORTED']),
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
  if (!policy.supportedCurrencies.includes(code)) {
    return 'POLICY_UNSUPPORTED';
  }
  return pricing.supportedCurrencies.includes(code) ? 'SUPPORTED' : 'PRICING_UNSUPPORTED';
};

const evidence = (input: PurchaseCurrencyResolutionInput) => ({
  contextRevision: input.request.contextRevision,
  policyRevision: input.policy.policyRevision,
  pricingRevision: input.pricing.pricingRevision,
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
    new Set(policy.supportedCurrencies).size !== policy.supportedCurrencies.length ||
    new Set(pricing.supportedCurrencies).size !== pricing.supportedCurrencies.length ||
    (policy.defaultCurrency !== null && !policy.supportedCurrencies.includes(policy.defaultCurrency))
  ) {
    return InconsistentPurchaseCurrencyPolicy.make({
      reason: 'Currency policy contains duplicates or a default outside its supported set',
    });
  }

  if (request.explicitChoice !== undefined) {
    if (!policy.explicitChoiceEnabled) {
      return ExplicitPurchaseCurrencyChoiceInvalid.make({
        currencyCode: request.explicitChoice,
        reason: 'EXPLICIT_CHOICE_DISABLED',
      });
    }
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

export const AKROS_LAUNCH_CURRENCY_POLICY: CurrencyPolicyDecision = Object.freeze({
  defaultCurrency: AKROS_LAUNCH_CURRENCY,
  explicitChoiceEnabled: true,
  policyRevision: 'akros-launch-czk-v1',
  supportedCurrencies: Object.freeze([AKROS_LAUNCH_CURRENCY]),
});

export const AKROS_LAUNCH_PRICING_CURRENCY_SUPPORT: PricingCurrencySupport = Object.freeze({
  pricingRevision: 'akros-launch-czk-v1',
  supportedCurrencies: Object.freeze([AKROS_LAUNCH_CURRENCY]),
});
