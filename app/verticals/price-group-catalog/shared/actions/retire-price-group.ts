import { Schema } from 'effect';

import {
  ExpectedPriceGroupCurrentEvidenceSchema,
  PriceGroupInstantSchema,
  PriceGroupReasonSchema,
} from '../domain/price-group.ts';

export { PriceGroupRetirementAcceptanceSchema as RetirePriceGroupResultSchema } from '../domain/price-group.ts';

export const RetirePriceGroupPayloadSchema = Schema.Struct({
  effectiveAt: PriceGroupInstantSchema,
  expectedCurrent: ExpectedPriceGroupCurrentEvidenceSchema,
  reason: PriceGroupReasonSchema,
});
export type RetirePriceGroupPayload = typeof RetirePriceGroupPayloadSchema.Type;
