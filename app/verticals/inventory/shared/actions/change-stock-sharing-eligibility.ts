import { Schema } from 'effect';

import {
  ChangeStockSharingEligibilityInputSchema,
  StockSharingEligibilitySchema,
} from '../domain/stock-sharing-eligibility.ts';
import { StockPositionRefSchema } from '../resources/stock-position.ts';

export const ChangeStockSharingEligibilityPayloadSchema = Schema.Struct({
  ...ChangeStockSharingEligibilityInputSchema.fields,
  positionRef: StockPositionRefSchema,
});
export type ChangeStockSharingEligibilityPayload = typeof ChangeStockSharingEligibilityPayloadSchema.Type;

export const ChangeStockSharingEligibilityResultSchema = StockSharingEligibilitySchema;
export type ChangeStockSharingEligibilityResult = typeof ChangeStockSharingEligibilityResultSchema.Type;
