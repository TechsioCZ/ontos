import { Schema } from 'effect';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());

/** Opaque owner-private linkage; existing public Price reads expose neither this ref nor raw source evidence. */
export const PriceSourceProvenanceRefSchema = checkedUuid.pipe(
  Schema.brand('PricingPriceSourceProvenanceRef'),
  Schema.decodeTo(checkedUuid),
);
export type PriceSourceProvenanceRef = typeof PriceSourceProvenanceRefSchema.Type;
