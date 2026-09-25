import { Schema } from 'effect';

import {
  EndStockSharingEligibilityInputSchema,
  StockSharingEligibilitySchema,
} from '../domain/stock-sharing-eligibility.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

export const EndStockSharingEligibilityPayloadSchema = Schema.Struct({
  ...EndStockSharingEligibilityInputSchema.fields,
  positionRef: StockPositionRefSchema,
});
export type EndStockSharingEligibilityPayload = typeof EndStockSharingEligibilityPayloadSchema.Type;

export const EndStockSharingEligibilityResultSchema = StockSharingEligibilitySchema;
export type EndStockSharingEligibilityResult = typeof EndStockSharingEligibilityResultSchema.Type;
