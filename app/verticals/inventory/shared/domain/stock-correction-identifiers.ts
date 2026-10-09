import { Schema } from 'effect';

export const StockCorrectionIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('StockCorrectionId'));
export type StockCorrectionId = typeof StockCorrectionIdSchema.Type;
