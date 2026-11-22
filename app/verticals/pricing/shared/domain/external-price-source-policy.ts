import { PricingCurrencyCodeSchema, PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PriceCommercialScopeSchema, PriceUnitBasisSchema } from '@app/pricing-contracts/domain/price-definition';
import {
  PriceSourceAuthoritySchema,
  PriceSourceMappingSchema,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { PriceGroupRefSchema } from '@app/price-group-catalog-contracts/resources/price-group';
import { Schema } from 'effect';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed(), Schema.isPattern(/^[0-9a-f-]+$/u));
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

/** Pricing-allocated identity of one standing external Price source policy. */
export const ExternalPriceSourcePolicyIdSchema = checkedUuid.pipe(
  Schema.brand('PricingExternalPriceSourcePolicyId'),
  Schema.decodeTo(checkedUuid),
);

/**
 * Which Price Group selectors of a Price key a policy covers. `NO_GROUP` covers base Prices only, `PRICE_GROUP`
 * one exact Price Group, and `ANY_PRICE_GROUP` every Price Group but never a base Price. Price Group existence
 * and compatibility stay with the Price write itself; the policy decides only who may assert the Price.
 */
export const ExternalPriceSourcePriceGroupCoverageSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('NO_GROUP') }),
  Schema.Struct({ kind: Schema.Literal('PRICE_GROUP'), priceGroupRef: PriceGroupRefSchema }),
  Schema.Struct({ kind: Schema.Literal('ANY_PRICE_GROUP') }),
]);
export type ExternalPriceSourcePriceGroupCoverage = typeof ExternalPriceSourcePriceGroupCoverageSchema.Type;

const periodIsOrdered = Schema.makeFilter(
  ({
    effectivePeriod,
  }: {
    readonly effectivePeriod: { readonly effectiveFrom: string; readonly effectiveTo?: string };
  }) =>
    effectivePeriod.effectiveTo === undefined || effectivePeriod.effectiveFrom < effectivePeriod.effectiveTo
      ? undefined
      : 'External Price source policy end must be after its start',
);
const groupBelongsToUnitTenant = Schema.makeFilter(
  ({
    priceGroupCoverage,
    unitBasis,
  }: {
    readonly priceGroupCoverage: ExternalPriceSourcePriceGroupCoverage;
    readonly unitBasis: typeof PriceUnitBasisSchema.Type;
  }) =>
    priceGroupCoverage.kind === 'PRICE_GROUP' &&
    priceGroupCoverage.priceGroupRef.tenantId !== unitBasis.unitRef.tenantId
      ? 'External Price source policy Price Group and Unit must belong to the same Tenant'
      : undefined,
);

const policyTermsFields = {
  authority: PriceSourceAuthoritySchema,
  commercialScope: PriceCommercialScopeSchema,
  currencyCode: PricingCurrencyCodeSchema,
  effectivePeriod: Schema.Struct({
    effectiveFrom: PricingInstantSchema,
    effectiveTo: Schema.optionalKey(PricingInstantSchema),
  }),
  mapping: PriceSourceMappingSchema,
  priceGroupCoverage: ExternalPriceSourcePriceGroupCoverageSchema,
  unitBasis: PriceUnitBasisSchema,
};
const policyTerms = Schema.Struct(policyTermsFields);
const nativeIdentifiersAreCanonical = Schema.makeFilter((terms: typeof policyTerms.Type) => {
  const identifiers = [
    terms.commercialScope.sellingLegalEntityId,
    terms.unitBasis.unitRef.resourceId,
    terms.unitBasis.unitRef.tenantId,
    ...(terms.priceGroupCoverage.kind === 'PRICE_GROUP'
      ? [terms.priceGroupCoverage.priceGroupRef.resourceId, terms.priceGroupCoverage.priceGroupRef.tenantId]
      : []),
  ];
  return identifiers.every(Schema.is(checkedUuid))
    ? undefined
    : 'External Price source policy native identifiers must be canonical lowercase UUIDs';
});

/**
 * What an operator verified once: this source authority, under this mapping contract, is the Price source for
 * every Price key of one commercial scope, currency and unit basis whose Price Group selector the coverage names.
 */
export const ExternalPriceSourcePolicyTermsSchema = policyTerms.check(
  nativeIdentifiersAreCanonical,
  periodIsOrdered,
  groupBelongsToUnitTenant,
);
export type ExternalPriceSourcePolicyTerms = typeof ExternalPriceSourcePolicyTermsSchema.Type;

const policyRecordFields = {
  ...policyTermsFields,
  family: Schema.Literal('PRICE'),
  ownerModuleId: Schema.Literal('commerce.pricing'),
  schemaVersion: Schema.Literal('1'),
  verificationRef: stableReference,
  verifiedAt: PricingInstantSchema,
};

/** A policy as Pricing stores it: the operator's verified terms plus Pricing's own verification time. */
export const ExternalPriceSourcePolicyRecordSchema = Schema.Struct(policyRecordFields).check(
  nativeIdentifiersAreCanonical,
  periodIsOrdered,
  groupBelongsToUnitTenant,
);
export type ExternalPriceSourcePolicyRecord = typeof ExternalPriceSourcePolicyRecordSchema.Type;

/** A stored policy as Pricing resolves it for one exact Price key; its period already includes any end. */
export const ExternalPriceSourcePolicySchema = Schema.Struct({
  ...policyRecordFields,
  policyId: ExternalPriceSourcePolicyIdSchema,
}).check(nativeIdentifiersAreCanonical, periodIsOrdered, groupBelongsToUnitTenant);
export type ExternalPriceSourcePolicy = typeof ExternalPriceSourcePolicySchema.Type;

/** The end of one policy, stamped with the trusted time Pricing recorded it. */
export const ExternalPriceSourcePolicyEndRecordSchema = Schema.Struct({
  effectiveTo: PricingInstantSchema,
  endedAt: PricingInstantSchema,
  policyId: ExternalPriceSourcePolicyIdSchema,
  verificationRef: stableReference,
});
export type ExternalPriceSourcePolicyEndRecord = typeof ExternalPriceSourcePolicyEndRecordSchema.Type;
