import { Schema } from 'effect';

/**
 * Payment consumes the authoritative Purchase Payable Amount exactly (#1148 "Money and term
 * invariants"): integer minor units (CZK haler), no floats, no FX, no rounding. Launch currency is
 * CZK only; another currency is rejected by the schema rather than converted.
 */
export const PAYMENT_LAUNCH_CURRENCY = 'CZK' as const;
export const PaymentCurrencySchema = Schema.Literal(PAYMENT_LAUNCH_CURRENCY);
export type PaymentCurrency = typeof PaymentCurrencySchema.Type;

export const PAYMENT_MAXIMUM_AMOUNT_MINOR = Number.MAX_SAFE_INTEGER;

/** Non-negative exact integer amount in minor units, bounded to the safe int53 range. */
export const PaymentAmountMinorSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: PAYMENT_MAXIMUM_AMOUNT_MINOR, minimum: 0 }),
);

/** Strictly positive amount: a monetary operation never moves zero (#1148 zero payable). */
export const PaymentPositiveAmountMinorSchema = PaymentAmountMinorSchema.check(Schema.isGreaterThan(0));

export const PaymentMonetaryAmountSchema = Schema.Struct({
  amountMinor: PaymentAmountMinorSchema,
  currency: PaymentCurrencySchema,
});
export type PaymentMonetaryAmount = typeof PaymentMonetaryAmountSchema.Type;

export const PaymentPositiveMonetaryAmountSchema = Schema.Struct({
  amountMinor: PaymentPositiveAmountMinorSchema,
  currency: PaymentCurrencySchema,
});
