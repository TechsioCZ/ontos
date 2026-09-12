import { Schema } from 'effect';

/** ISO 4217-style wire code. Recognition remains a separate catalog decision. */
export const CurrencyCodeSchema = Schema.String.check(Schema.isPattern(/^[A-Z]{3}$/u));
export type CurrencyCode = typeof CurrencyCodeSchema.Type;

export const AKROS_LAUNCH_CURRENCY: CurrencyCode = 'CZK';

export const CurrencyCodeSetSchema = Schema.Array(CurrencyCodeSchema).check(
  Schema.makeFilter((codes) => (new Set(codes).size === codes.length ? undefined : 'Currency codes must be unique')),
);
