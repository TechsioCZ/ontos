import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PriceIdentityKeySchema } from '@app/pricing-contracts/domain/price-definition';
import {
  PriceSourceAuthoritySchema,
  PriceSourceMappingSchema,
} from '@app/pricing-contracts/domain/price-source-provenance';
import { Schema } from 'effect';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());

/**
 * What an operator verified: one source authority, under one mapping contract, may assert the Price of one
 * exact canonical key from a start time. Pricing adds the verification time itself; a caller cannot date it.
 */
export const GrantExternalPriceSourceAuthorityPayloadSchema = Schema.Struct({
  authority: PriceSourceAuthoritySchema,
  effectivePeriod: Schema.Struct({
    effectiveFrom: PricingInstantSchema,
    effectiveTo: Schema.optionalKey(PricingInstantSchema),
  }),
  exactIdentityKey: PriceIdentityKeySchema,
  mapping: PriceSourceMappingSchema,
  reason: boundedReason,
  verificationRef: stableReference,
}).check(
  Schema.makeFilter(({ effectivePeriod }) =>
    effectivePeriod.effectiveTo === undefined || effectivePeriod.effectiveFrom < effectivePeriod.effectiveTo
      ? undefined
      : 'Source Authority grant end must be after its start',
  ),
);
export type GrantExternalPriceSourceAuthorityPayload = typeof GrantExternalPriceSourceAuthorityPayloadSchema.Type;

export const GrantExternalPriceSourceAuthorityResultSchema = Schema.Struct({
  outcome: Schema.Literals(['STORED', 'REUSED']),
  verifiedAt: PricingInstantSchema,
});
export type GrantExternalPriceSourceAuthorityResult = typeof GrantExternalPriceSourceAuthorityResultSchema.Type;
