import { PricingCurrencyCodeSchema, PricingInstantSchema } from '../apis/current-supported-currencies.ts';
import { PriceNonNegativeDecimalSchema, PriceRevisionIdSchema } from '../domain/price-definition.ts';
import { PriceSourceAssertionInputSchema } from '../domain/price-source-provenance.ts';
import {
  ExpectedPriceCurrentSchema,
  PriceEffectivePeriodSchema,
  PriceScheduleAcknowledgementSchema,
  PriceScheduleRevisionSchema,
  ScheduledPriceRevisionSchema,
} from '../domain/price-schedule.ts';
import { PriceRefSchema } from '../resources/price.ts';
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
    /**
     * The instant the new value takes effect, when the source asserts its own: it must not be after the operation
     * and not before the Current Revision it replaces. Without it the value takes effect at the operation time.
     * An acknowledgement carries its own period, so the two never travel together.
     */
    effectiveFrom: Schema.optionalKey(PricingInstantSchema),
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
