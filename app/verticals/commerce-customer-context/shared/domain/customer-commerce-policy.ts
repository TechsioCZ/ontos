import { Result, Schema } from 'effect';
import { CatalogResourceRefSchema } from '@app/catalog/domain/catalog-revision-reference';
import { CurrencyCodeSchema } from './currency.ts';
import { ProfileInstantSchema } from './profile-contracts.ts';

const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const jsonString = Schema.fromJsonString(Schema.Unknown);
const commerceCatalogModuleId = 'commerce.catalog' as const;

export const CustomerCommercePolicyActionInvocationIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerCommercePolicyActionInvocationId')),
);
export const CustomerCommercePolicyActorPrincipalIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerCommercePolicyActorPrincipalId')),
);
export const CustomerCommercePolicyChannelIdSchema = Schema.toEncoded(
  stableReference.pipe(Schema.brand('CustomerCommercePolicyChannelId')),
);
export const CustomerCommercePolicyCommerceMarketIdSchema = Schema.toEncoded(
  stableReference.pipe(Schema.brand('CustomerCommercePolicyCommerceMarketId')),
);
export const CustomerCommercePolicyIdempotencyKeySchema = Schema.toEncoded(
  stableReference.pipe(Schema.brand('CustomerCommercePolicyIdempotencyKey')),
);
const CustomerCommercePolicyResourceIdSchema = Schema.toEncoded(
  stableReference.pipe(Schema.brand('CustomerCommercePolicyResourceId')),
);
export const CustomerCommercePolicyRevisionIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerCommercePolicyRevisionId')),
);
export const CustomerCommercePolicySellingLegalEntityIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerCommercePolicySellingLegalEntityId')),
);
export const CustomerCommercePolicyStorefrontIdSchema = Schema.toEncoded(
  stableReference.pipe(Schema.brand('CustomerCommercePolicyStorefrontId')),
);
export const CustomerCommercePolicyTenantIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CustomerCommercePolicyTenantId')),
);

/** A canonical UTC instant used by Customer Commerce Policy contracts. */
export const CustomerCommercePolicyInstantSchema = ProfileInstantSchema.pipe(
  Schema.brand('CustomerCommercePolicyInstant'),
);
export type CustomerCommercePolicyInstant = typeof CustomerCommercePolicyInstantSchema.Type;

export const CustomerCommercePolicyFieldIdSchema = Schema.Literals([
  'MARKET_BOOTSTRAP',
  'PURCHASE_CURRENCY',
  'PAYMENT_TERM',
  'COMMERCE_QUANTITY_RULE',
]);
export type CustomerCommercePolicyFieldId = typeof CustomerCommercePolicyFieldIdSchema.Type;

export const customerCommercePolicyFieldCatalog = Object.freeze([
  {
    allowsCrossChannelDefault: true,
    allowsMarketSelector: false,
    composition: 'REPLACEABLE_DEFAULT',
    id: 'MARKET_BOOTSTRAP',
    schemaVersion: '1',
  },
  {
    allowsCrossChannelDefault: true,
    allowsMarketSelector: true,
    composition: 'REPLACEABLE_DEFAULT_WITH_NON_RELAXABLE_CONSTRAINTS',
    id: 'PURCHASE_CURRENCY',
    schemaVersion: '1',
  },
  {
    allowsCrossChannelDefault: true,
    allowsMarketSelector: true,
    composition: 'REPLACEABLE_DEFAULT_WITH_NON_RELAXABLE_CONSTRAINTS',
    id: 'PAYMENT_TERM',
    schemaVersion: '1',
  },
  {
    allowsCrossChannelDefault: false,
    allowsMarketSelector: true,
    composition: 'REPLACEABLE_ENVELOPE_WITH_NON_RELAXABLE_CONSTRAINTS',
    id: 'COMMERCE_QUANTITY_RULE',
    schemaVersion: '1',
  },
] as const satisfies readonly {
  readonly allowsCrossChannelDefault: boolean;
  readonly allowsMarketSelector: boolean;
  readonly composition:
    | 'REPLACEABLE_DEFAULT'
    | 'REPLACEABLE_DEFAULT_WITH_NON_RELAXABLE_CONSTRAINTS'
    | 'REPLACEABLE_ENVELOPE_WITH_NON_RELAXABLE_CONSTRAINTS';
  readonly id: CustomerCommercePolicyFieldId;
  readonly schemaVersion: '1';
}[]);

const SellerScopeSchema = Schema.Struct({
  kind: Schema.Literal('SELLER'),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const ChannelSellerScopeSchema = Schema.Struct({
  channelId: CustomerCommercePolicyChannelIdSchema,
  kind: Schema.Literal('CHANNEL_SELLER'),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const MarketChannelSellerScopeSchema = Schema.Struct({
  channelId: CustomerCommercePolicyChannelIdSchema,
  commerceMarketId: CustomerCommercePolicyCommerceMarketIdSchema,
  kind: Schema.Literal('MARKET_CHANNEL_SELLER'),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const StorefrontMarketChannelSellerScopeSchema = Schema.Struct({
  channelId: CustomerCommercePolicyChannelIdSchema,
  commerceMarketId: CustomerCommercePolicyCommerceMarketIdSchema,
  kind: Schema.Literal('STOREFRONT_MARKET_CHANNEL_SELLER'),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
  storefrontId: CustomerCommercePolicyStorefrontIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const StorefrontChannelSellerScopeSchema = Schema.Struct({
  channelId: CustomerCommercePolicyChannelIdSchema,
  kind: Schema.Literal('STOREFRONT_CHANNEL_SELLER'),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
  storefrontId: CustomerCommercePolicyStorefrontIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/** Ordinary Market-dependent replacement ranks; Storefront without Market is deliberately absent. */
export const OrdinaryCustomerCommercePolicyScopeSchema = Schema.Union([
  StorefrontMarketChannelSellerScopeSchema,
  MarketChannelSellerScopeSchema,
  ChannelSellerScopeSchema,
  SellerScopeSchema,
]);
export type OrdinaryCustomerCommercePolicyScope = typeof OrdinaryCustomerCommercePolicyScopeSchema.Type;

export const MarketBootstrapPolicyScopeSchema = Schema.Union([
  StorefrontChannelSellerScopeSchema,
  ChannelSellerScopeSchema,
  SellerScopeSchema,
]);
export type MarketBootstrapPolicyScope = typeof MarketBootstrapPolicyScopeSchema.Type;

/** Quantity has no cross-Channel Seller baseline and never permits Storefront without Market. */
export const CommerceQuantityPolicyScopeSchema = Schema.Union([
  StorefrontMarketChannelSellerScopeSchema,
  MarketChannelSellerScopeSchema,
  ChannelSellerScopeSchema,
]);
export type CommerceQuantityPolicyScope = typeof CommerceQuantityPolicyScopeSchema.Type;

export const MarketBootstrapValueSchema = Schema.Struct({
  defaultChannelId: CustomerCommercePolicyChannelIdSchema,
  defaultCommerceMarketId: CustomerCommercePolicyCommerceMarketIdSchema,
  defaultSellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
  kind: Schema.Literal('DEFAULT_MARKET_TUPLE'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export const PurchaseCurrencyConstraintValueSchema = Schema.Struct({
  currencyCode: CurrencyCodeSchema,
  kind: Schema.Literal('ALLOWED_CURRENCY_CONSTRAINT'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const PurchaseCurrencyDefaultValueSchema = Schema.Struct({
  currencyCode: CurrencyCodeSchema,
  kind: Schema.Literal('DEFAULT_CURRENCY'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const PurchaseCurrencyValueSchema = Schema.Union([
  PurchaseCurrencyConstraintValueSchema,
  PurchaseCurrencyDefaultValueSchema,
]);

const PaymentTermRefSchema = Schema.Struct({
  moduleId: Schema.Literal('payment.term-catalog'),
  resourceId: CustomerCommercePolicyResourceIdSchema,
  resourceType: Schema.Literal('payment.term-catalog.payment-term'),
  tenantId: CustomerCommercePolicyTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const PaymentTermConstraintValueSchema = Schema.Struct({
  kind: Schema.Literal('APPLICABLE_PAYMENT_TERM_CONSTRAINT'),
  paymentTermRef: PaymentTermRefSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const PaymentTermDefaultValueSchema = Schema.Struct({
  kind: Schema.Literal('FALLBACK_PAYMENT_TERM'),
  paymentTermRef: PaymentTermRefSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const PaymentTermExplicitChoicePolicyValueSchema = Schema.Struct({
  enabled: Schema.Boolean,
  kind: Schema.Literal('EXPLICIT_PAYMENT_TERM_CHOICE_POLICY'),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export const PaymentTermValueSchema = Schema.Union([
  PaymentTermConstraintValueSchema,
  PaymentTermDefaultValueSchema,
  PaymentTermExplicitChoicePolicyValueSchema,
]);

const CatalogProductRefSchema = Schema.Struct({
  moduleId: Schema.Literal(commerceCatalogModuleId),
  resourceId: CustomerCommercePolicyResourceIdSchema,
  resourceType: Schema.Literal('commerce.catalog.product'),
  tenantId: CustomerCommercePolicyTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const CatalogVariantRefSchema = Schema.Struct({
  moduleId: Schema.Literal(commerceCatalogModuleId),
  resourceId: CustomerCommercePolicyResourceIdSchema,
  resourceType: Schema.Literal('commerce.catalog.variant'),
  tenantId: CustomerCommercePolicyTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const CatalogPackageOptionRefSchema = Schema.Struct({
  moduleId: Schema.Literal(commerceCatalogModuleId),
  resourceId: CustomerCommercePolicyResourceIdSchema,
  resourceType: Schema.Literal('commerce.catalog.package-definition'),
  tenantId: CustomerCommercePolicyTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

const CommerceQuantitySelectorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('ALL') }).annotate({ parseOptions: { onExcessProperty: 'error' } }),
  Schema.Struct({ kind: Schema.Literal('PRODUCT'), productRef: CatalogProductRefSchema }).annotate({
    parseOptions: { onExcessProperty: 'error' },
  }),
  Schema.Struct({ kind: Schema.Literal('VARIANT'), variantRef: CatalogVariantRefSchema }).annotate({
    parseOptions: { onExcessProperty: 'error' },
  }),
  Schema.Struct({ kind: Schema.Literal('PACKAGE_OPTION'), packageOptionRef: CatalogPackageOptionRefSchema }).annotate({
    parseOptions: { onExcessProperty: 'error' },
  }),
]);
export type CommerceQuantitySelector = typeof CommerceQuantitySelectorSchema.Type;

export const ExactPositiveCommerceQuantitySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.0*[1-9][0-9]*)$/u),
).pipe(Schema.brand('ExactPositiveCommerceQuantity'));
export type ExactPositiveCommerceQuantity = typeof ExactPositiveCommerceQuantitySchema.Type;

export const CommerceQuantityBasisSchema = Schema.Struct({
  targetDivisibilityRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
  targetRef: CatalogResourceRefSchema,
  unitRef: CatalogResourceRefSchema,
  unitRuleRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
}).check(
  Schema.makeFilter(({ targetRef, unitRef }) =>
    targetRef.tenantId === unitRef.tenantId
      ? undefined
      : [{ issue: 'Quantity target and Unit must belong to the same Tenant', path: ['unitRef', 'tenantId'] }],
  ),
);
export type CommerceQuantityBasis = typeof CommerceQuantityBasisSchema.Type;

const compareExactPositiveQuantities = (left: string, right: string): -1 | 0 | 1 => {
  const [leftInteger = '0', leftFraction = ''] = left.split('.');
  const [rightInteger = '0', rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const scaledLeft = BigInt(`${leftInteger}${leftFraction}`) * 10n ** BigInt(scale - leftFraction.length);
  const scaledRight = BigInt(`${rightInteger}${rightFraction}`) * 10n ** BigInt(scale - rightFraction.length);
  if (scaledLeft < scaledRight) {
    return -1;
  }
  if (scaledLeft > scaledRight) {
    return 1;
  }
  return 0;
};

export const QuantityEnvelopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NO_COMMERCIAL_QUANTITY_RESTRICTION') }).annotate({
    parseOptions: { onExcessProperty: 'error' },
  }),
  Schema.Struct({
    kind: Schema.Literal('BOUNDED'),
    maximum: Schema.toEncoded(Schema.OptionFromNullOr(ExactPositiveCommerceQuantitySchema)),
    minimum: Schema.toEncoded(Schema.OptionFromNullOr(ExactPositiveCommerceQuantitySchema)),
    multiple: Schema.toEncoded(Schema.OptionFromNullOr(ExactPositiveCommerceQuantitySchema)),
  })
    .check(
      Schema.makeFilter(({ maximum, minimum, multiple }) =>
        maximum !== null || minimum !== null || multiple !== null
          ? undefined
          : 'A bounded Commerce Quantity envelope must declare a minimum, maximum, or multiple',
      ),
      Schema.makeFilter(({ maximum, minimum }) =>
        minimum === null || maximum === null || compareExactPositiveQuantities(minimum, maximum) <= 0
          ? undefined
          : [{ issue: 'minimum must be less than or equal to maximum', path: ['minimum'] }],
      ),
    )
    .annotate({ parseOptions: { onExcessProperty: 'error' } }),
]);
export type QuantityEnvelope = typeof QuantityEnvelopeSchema.Type;

export const CommerceQuantityRuleValueSchema = Schema.Struct({
  basis: CommerceQuantityBasisSchema,
  constraintMode: Schema.Literals(['REPLACEABLE_ENVELOPE', 'NON_RELAXABLE_CONSTRAINT']),
  envelope: QuantityEnvelopeSchema,
  kind: Schema.Literal('COMMERCE_QUANTITY_RULE'),
  selector: CommerceQuantitySelectorSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
const commonRevisionFields = {
  actionInvocationId: CustomerCommercePolicyActionInvocationIdSchema,
  actorPrincipalId: CustomerCommercePolicyActorPrincipalIdSchema,
  effectiveFrom: CustomerCommercePolicyInstantSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerCommercePolicyInstantSchema)),
  idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
  lifecycle: Schema.Literals(['SCHEDULED', 'ACTIVE', 'RETIRED']),
  reason,
  revisionId: CustomerCommercePolicyRevisionIdSchema,
  tenantId: CustomerCommercePolicyTenantIdSchema,
} as const;

const halfOpenRevisionPeriod = Schema.makeFilter(
  (revision: { readonly effectiveFrom: string; readonly effectiveTo: null | string }) =>
    revision.effectiveTo === null || revision.effectiveTo > revision.effectiveFrom
      ? undefined
      : [{ issue: 'effectiveTo must be later than effectiveFrom', path: ['effectiveTo'] }],
);

const marketBootstrapTupleMatchesScope = Schema.makeFilter(
  (revision: {
    readonly scope: MarketBootstrapPolicyScope;
    readonly value: typeof MarketBootstrapValueSchema.Type;
  }) => {
    const { scope, value } = revision;
    if (value.defaultSellingLegalEntityId !== scope.sellingLegalEntityId) {
      return [
        { issue: 'Default seller must match the policy scope seller', path: ['value', 'defaultSellingLegalEntityId'] },
      ];
    }
    if (scope.kind !== 'SELLER' && value.defaultChannelId !== scope.channelId) {
      return [
        { issue: 'Default Channel must match the Channel fixed by policy scope', path: ['value', 'defaultChannelId'] },
      ];
    }
    return true;
  },
);

export const MarketBootstrapPolicyRevisionSchema = Schema.Struct({
  ...commonRevisionFields,
  field: Schema.Literal('MARKET_BOOTSTRAP'),
  scope: MarketBootstrapPolicyScopeSchema,
  value: MarketBootstrapValueSchema,
}).check(halfOpenRevisionPeriod, marketBootstrapTupleMatchesScope);
export type MarketBootstrapPolicyRevision = typeof MarketBootstrapPolicyRevisionSchema.Type;
export const PurchaseCurrencyPolicyRevisionSchema = Schema.Struct({
  ...commonRevisionFields,
  field: Schema.Literal('PURCHASE_CURRENCY'),
  scope: OrdinaryCustomerCommercePolicyScopeSchema,
  value: PurchaseCurrencyValueSchema,
}).check(halfOpenRevisionPeriod);
export type PurchaseCurrencyPolicyRevision = typeof PurchaseCurrencyPolicyRevisionSchema.Type;
export const PaymentTermPolicyRevisionSchema = Schema.Struct({
  ...commonRevisionFields,
  field: Schema.Literal('PAYMENT_TERM'),
  scope: OrdinaryCustomerCommercePolicyScopeSchema,
  value: PaymentTermValueSchema,
}).check(halfOpenRevisionPeriod);
export type PaymentTermPolicyRevision = typeof PaymentTermPolicyRevisionSchema.Type;
export const CommerceQuantityRuleRevisionSchema = Schema.Struct({
  ...commonRevisionFields,
  field: Schema.Literal('COMMERCE_QUANTITY_RULE'),
  scope: CommerceQuantityPolicyScopeSchema,
  value: CommerceQuantityRuleValueSchema,
}).check(
  halfOpenRevisionPeriod,
  Schema.makeFilter((revision) => {
    let selectorTenantId = revision.tenantId;
    if (revision.value.selector.kind === 'PRODUCT') {
      selectorTenantId = revision.value.selector.productRef.tenantId;
    } else if (revision.value.selector.kind === 'VARIANT') {
      selectorTenantId = revision.value.selector.variantRef.tenantId;
    } else if (revision.value.selector.kind === 'PACKAGE_OPTION') {
      selectorTenantId = revision.value.selector.packageOptionRef.tenantId;
    }
    return selectorTenantId === revision.tenantId && revision.value.basis.targetRef.tenantId === revision.tenantId
      ? undefined
      : 'Quantity selector, basis, and policy Revision must belong to the same Tenant';
  }),
);
export type CommerceQuantityRuleRevision = typeof CommerceQuantityRuleRevisionSchema.Type;

export const CustomerCommercePolicyRevisionSchema = Schema.Union([
  MarketBootstrapPolicyRevisionSchema,
  PurchaseCurrencyPolicyRevisionSchema,
  PaymentTermPolicyRevisionSchema,
  CommerceQuantityRuleRevisionSchema,
]);
export type CustomerCommercePolicyRevision = typeof CustomerCommercePolicyRevisionSchema.Type;

export const PurchaseCurrencyPolicyCurrentFailureSchema = Schema.Literals([
  'MISSING_PURCHASE_CURRENCY_POLICY',
  'INCONSISTENT_PURCHASE_CURRENCY_POLICY',
  'BROKEN_PURCHASE_CURRENCY_POLICY',
  'PURCHASE_CURRENCY_POLICY_UNVERIFIABLE',
]);
export const PaymentTermPolicyCurrentFailureSchema = Schema.Literals([
  'MISSING_PAYMENT_TERM_POLICY',
  'INCONSISTENT_PAYMENT_TERM_POLICY',
  'BROKEN_PAYMENT_TERM_POLICY',
  'PAYMENT_TERM_POLICY_UNVERIFIABLE',
]);
export const CommerceQuantityPolicyCurrentFailureSchema = Schema.Literals([
  'MISSING_COMMERCE_QUANTITY_POLICY',
  'INCONSISTENT_COMMERCE_QUANTITY_POLICY',
  'BROKEN_COMMERCE_QUANTITY_ASSIGNMENT',
  'COMMERCE_QUANTITY_POLICY_UNVERIFIABLE',
]);

export const CustomerCommercePolicyRevisionMeaningChangeSchema = Schema.TaggedStruct('REVISION_MEANING_CHANGED', {
  revisionId: CustomerCommercePolicyRevisionIdSchema,
});
export type CustomerCommercePolicyRevisionMeaningChange = typeof CustomerCommercePolicyRevisionMeaningChangeSchema.Type;

const meaning = (revision: CustomerCommercePolicyRevision): string =>
  Result.getOrThrow(
    Schema.encodeResult(jsonString)({
      effectiveFrom: revision.effectiveFrom,
      effectiveTo: revision.effectiveTo,
      field: revision.field,
      scope: revision.scope,
      tenantId: revision.tenantId,
      value: revision.value,
    }),
  );

export const assertCustomerCommercePolicyRevisionMeaningImmutable = (
  previous: CustomerCommercePolicyRevision,
  next: CustomerCommercePolicyRevision,
): CustomerCommercePolicyRevisionMeaningChange | undefined =>
  previous.revisionId === next.revisionId && meaning(previous) !== meaning(next)
    ? { _tag: 'REVISION_MEANING_CHANGED', revisionId: previous.revisionId }
    : undefined;
