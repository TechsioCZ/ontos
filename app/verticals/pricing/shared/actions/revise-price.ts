import { PricingCurrencyCodeSchema } from '@app/pricing-contracts/current-supported-currencies';
import { PriceNonNegativeDecimalSchema, PriceRevisionIdSchema } from '@app/pricing-contracts/domain/price-definition';
import { PriceSourceAssertionInputSchema } from '@app/pricing-contracts/domain/price-source-provenance';
import {
  ExpectedPriceCurrentSchema,
  PriceEffectivePeriodSchema,
  PriceScheduleAcknowledgementSchema,
  PriceScheduleRevisionSchema,
  ScheduledPriceRevisionSchema,
} from '@app/pricing-contracts/domain/price-schedule';
import { PriceRefSchema } from '@app/pricing-contracts/resources/price';
import { Schema } from 'effect';

const reasonSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const monetaryAmountSchema = Schema.Struct({
  amount: PriceNonNegativeDecimalSchema,
  currencyCode: PricingCurrencyCodeSchema,
});
const target = { priceRef: PriceRefSchema, reason: reasonSchema };

export const RevisePricePayloadSchema = Schema.Union([
  Schema.Struct({
    ...target,
    acknowledgement: Schema.optionalKey(PriceScheduleAcknowledgementSchema),
    expectedCurrent: ExpectedPriceCurrentSchema,
    intent: Schema.Literal('VALUE_ONLY_CURRENT'),
    monetaryAmount: monetaryAmountSchema,
    sourceAssertion: PriceSourceAssertionInputSchema,
  }),
  Schema.Struct({
    ...target,
    effectivePeriod: PriceEffectivePeriodSchema,
    expectedScheduleRevision: PriceScheduleRevisionSchema,
    intent: Schema.Literal('SCHEDULE_REVISION'),
    monetaryAmount: monetaryAmountSchema,
    sourceAssertion: PriceSourceAssertionInputSchema,
  }),
  Schema.Struct({
    ...target,
    expectedScheduleRevision: PriceScheduleRevisionSchema,
    intent: Schema.Literal('CORRECT_REVISION'),
    monetaryAmount: monetaryAmountSchema,
    sourceAssertion: PriceSourceAssertionInputSchema,
    targetRevisionId: PriceRevisionIdSchema,
  }),
  Schema.Struct({
    ...target,
    acknowledgement: Schema.optionalKey(PriceScheduleAcknowledgementSchema),
    expectedCurrent: ExpectedPriceCurrentSchema,
    intent: Schema.Literal('RETIRE_CURRENT'),
  }),
]);
export type RevisePricePayload = typeof RevisePricePayloadSchema.Type;

export const RevisePriceResultSchema = Schema.Struct({
  outcome: Schema.Literals(['PRICE_REVISION_CREATED', 'PRICE_REVISION_UNCHANGED']),
  revision: ScheduledPriceRevisionSchema,
});
export type RevisePriceResult = typeof RevisePriceResultSchema.Type;

export { reasonSchema as RevisePriceReasonSchema };
