import { PricingDiscountContributionSchema } from '@app/pricing-contracts/domain/discount';
import type { PricingDiscountContribution } from '@app/pricing-contracts/domain/discount';
import { Effect, Option, Schema } from 'effect';

export class PricingDiscountInterpretationRejected extends Schema.TaggedError<PricingDiscountInterpretationRejected>()(
  'PricingDiscountInterpretationRejected',
  {
    code: Schema.Literal('CONTRIBUTION_INVALID'),
    reason: Schema.String,
  },
) {}

export type PricingDiscountLayer = PricingDiscountContribution['discountType']['audience']['kind'];
export const PricingDiscountApplicationCountSchema = Schema.Literals([
  'ONCE_PER_PRICING_DECISION',
  'ONCE_PER_STABLE_LINE',
]);
export type PricingDiscountApplicationCount = typeof PricingDiscountApplicationCountSchema.Type;

export type PricingDiscountEffectSemantics =
  | {
      readonly basis: 'DISCOUNTABLE_LINE_BASIS';
      readonly kind: 'PERCENTAGE';
      readonly level: string;
    }
  | {
      readonly configuredAmount: {
        readonly amount: string;
        readonly currencyCode: string;
      };
      readonly kind: 'FIXED_MONETARY_AMOUNT';
      readonly multiplication: 'ONCE';
    };

export interface PricingDiscountInterpretation {
  readonly applicationCount: PricingDiscountApplicationCount;
  readonly contribution: PricingDiscountContribution;
  readonly contributionDirection: 'NON_POSITIVE_REDUCTION';
  readonly effectSemantics: PricingDiscountEffectSemantics;
  readonly layer: PricingDiscountLayer;
}

const rejection = (): PricingDiscountInterpretationRejected =>
  new PricingDiscountInterpretationRejected({
    code: 'CONTRIBUTION_INVALID',
    reason: 'Discount contribution does not satisfy the closed Pricing-owned Discount contract',
  });

const semanticsFor = (contribution: PricingDiscountContribution): PricingDiscountEffectSemantics => {
  const { effect } = contribution.discountType;
  return effect.kind === 'PERCENTAGE'
    ? { basis: 'DISCOUNTABLE_LINE_BASIS', kind: 'PERCENTAGE', level: effect.level }
    : {
        configuredAmount: effect.level,
        kind: 'FIXED_MONETARY_AMOUNT',
        multiplication: 'ONCE',
      };
};

/**
 * Validates and interprets one already-applied Discount contribution in isolation.
 *
 * The decoded contribution retains the exact Decision, Variant line, commercial scope,
 * currency, quantity/unit basis, and configured effect. This service deliberately does not
 * select Revisions, collapse audience layers, enforce cross-fact cardinality, allocate a
 * whole-purchase reduction, or perform FX.
 */
export const interpretPricingDiscountContribution = (
  input: PricingDiscountContribution,
): Effect.Effect<PricingDiscountInterpretation, PricingDiscountInterpretationRejected> => {
  const decoded = Schema.decodeOption(PricingDiscountContributionSchema, {
    onExcessProperty: 'error',
  })(input);
  if (Option.isNone(decoded)) {
    return Effect.fail(rejection());
  }
  const contribution = decoded.value;
  return Effect.succeed({
    applicationCount:
      contribution.target.kind === 'VARIANT_LINE' ? 'ONCE_PER_STABLE_LINE' : 'ONCE_PER_PRICING_DECISION',
    contribution,
    contributionDirection: 'NON_POSITIVE_REDUCTION',
    effectSemantics: semanticsFor(contribution),
    layer: contribution.discountType.audience.kind,
  });
};
